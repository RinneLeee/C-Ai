import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Helper to clean stream history back into readable text for the LLM context
// This ensures the AI remembers conversational chat but ignores heavy raw code data
const sanitizeHistoryForLLM = (content, isForJSONModel) => {
    if (!content.includes('{"t":')) return content;
    
    let extractedText = "";
    const lines = content.split('\n');
    
    lines.forEach(line => {
        if(line.trim().startsWith('{')) {
            try {
                const parsed = JSON.parse(line);
                if (parsed.t === 'queen_chunk' && parsed.chunk) {
                    extractedText += parsed.chunk;
                }
            } catch(e) {}
        }
    });

    if (extractedText.trim().length > 0) {
        return extractedText; 
    }

    if (isForJSONModel) {
         return '{"tasks": [{"id": "history_1", "role": "System Orchestrator", "description": "Previous swarm execution data omitted.", "dependsOn": []}]}';
    } else {
         return "[Previous Swarm Execution Data Omitted]";
    }
};

export async function POST(req) {
  try {
    const { chatId, deviceId, newMessage, model, isAgentMode, swarmTier, maxAgents, swarmPhase, activePlan } = await req.json();

    if (!chatId || !deviceId || !newMessage) return Response.json({ error: 'Missing required fields' }, { status: 400 });

    const queenModel = model || 'deepseek-v4-pro';
    const tier = swarmTier || 'smart';
    const agentLimit = maxAgents || 5;
    let finalUserContent = newMessage.content;

    // 1. Vision Logic 
    if (newMessage.images && newMessage.images.length > 0) {
      try {
        const visionClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const visionContentArray = [{ type: 'text', text: 'Extract all visible text, describe layouts, UI elements, code snippets, colors, and overall context.' }];
        newMessage.images.forEach(base64Uri => visionContentArray.push({ type: 'image_url', image_url: { url: base64Uri } }));
        const visionResponse = await visionClient.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: visionContentArray }],
        });
        finalUserContent = `[System Attached Image Context:\n${visionResponse.choices[0].message.content}\n]\n\nUser Request: ${finalUserContent}`;
      } catch (e) {
        console.error("Vision Pass Failed:", e);
      }
    }

    // 2. DB History & Title 
    const { data: history } = await supabase.from('messages').select('role, content').eq('chat_id', chatId).order('created_at', { ascending: true });
      
    const isFirstMessage = !history || history.length === 0;
    let generatedTitle = "New Swarm";

    let queenClient;
    let queenTargetName = queenModel;
    if (queenModel.startsWith('deepseek')) {
      queenClient = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' });
      queenTargetName = 'deepseek-chat';
    } else if (queenModel.startsWith('qwen')) {
      queenClient = new OpenAI({ apiKey: process.env.QWEN_API_KEY, baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' });
      queenTargetName = queenModel === 'qwen3.7-plus' ? 'qwen-plus' : 'qwen-max';
    }

    if (isFirstMessage) {
        try {
            const titleCompletion = await queenClient.chat.completions.create({
                model: queenTargetName,
                messages: [{ role: 'system', content: 'Generate a short 3 to 5 word title. Respond ONLY with the title. No quotes.' }, { role: 'user', content: finalUserContent.substring(0, 500) }],
            });
            generatedTitle = titleCompletion.choices[0].message.content.trim();
        } catch (e) { console.error("Title gen failed"); }
        await supabase.from('chats').upsert([{ id: chatId, device_id: deviceId, title: generatedTitle }], { onConflict: 'id' });
    } else {
        await supabase.from('chats').upsert([{ id: chatId, device_id: deviceId }], { onConflict: 'id', ignoreDuplicates: true });
    }

    // 3. STREAM & MULTIPLEX ORCHESTRATION
    const stream = new ReadableStream({
      async start(controller) {
        let fullAssistantResponse = "";
        
        const sendEvent = (event) => {
          const str = JSON.stringify(event) + "\n\n";
          fullAssistantResponse += str;
          controller.enqueue(new TextEncoder().encode(str));
        };

        try {
          // ==========================================
          // PHASE 0: INTENT ROUTING (SWARM VS CHAT)
          // ==========================================
          let isChatIntent = false;
          if (isAgentMode && swarmPhase !== 'execute') {
              const intentPrompt = `You are an intent router. Analyze the user's latest request in the context of a software development project.
              Reply EXACTLY with "BUILD" if the user is asking to create, write, implement code, build a project, modify architecture, or start a development task.
              Reply EXACTLY with "CHAT" if the user is just asking a general question, greeting, asking for clarification, or discussing concepts without requesting immediate code execution.`;

              try {
                  const intentCompletion = await queenClient.chat.completions.create({
                      model: queenTargetName,
                      messages: [
                          { role: 'system', content: intentPrompt },
                          { role: 'user', content: finalUserContent }
                      ],
                      max_tokens: 10,
                      temperature: 0
                  });
                  if (intentCompletion.choices[0].message.content.includes('CHAT')) {
                      isChatIntent = true;
                  }
              } catch (e) {
                  console.error("Intent Check Failed:", e);
              }
          }

          if (isChatIntent) {
              // ==========================================
              // CONVERSATIONAL CHAT (BYPASS SWARM PLAN)
              // ==========================================
              let chatMessages = [{ role: 'system', content: 'You are the Queen Orchestrator, an expert AI project manager and lead developer. Answer the user explicitly, concisely, and helpfully. You have full memory of the conversation.' }];
              
              if (history) {
                  history.forEach(msg => {
                      chatMessages.push({ role: msg.role, content: sanitizeHistoryForLLM(msg.content, false) });
                  });
              }
              chatMessages.push({ role: 'user', content: finalUserContent });

              const chatStream = await queenClient.chat.completions.create({
                  model: queenTargetName,
                  messages: chatMessages,
                  stream: true
              });

              for await (const chunk of chatStream) {
                  const textChunk = chunk.choices[0]?.delta?.content || "";
                  if (textChunk) {
                      sendEvent({ t: "queen_chunk", chunk: textChunk });
                  }
              }
              
              const messagesToInsert = [
                  { chat_id: chatId, role: 'user', content: finalUserContent },
                  { chat_id: chatId, role: 'assistant', content: fullAssistantResponse }
              ];
              await supabase.from('messages').insert(messagesToInsert);
              controller.close();
              return; // Halt execution so Swarm doesn't trigger
          }


          // ==========================================
          // PHASE 1: THE QUEEN'S PLANNING (BUILD INTENT)
          // ==========================================
          if (isAgentMode && swarmPhase !== 'execute' && !isChatIntent) {
              const planPrompt = `
              You are the Queen Orchestrator (Project Manager). The user is the Main Project Lead.
              Your job right now is ONLY to plan the architecture and distribute tasks to agents.
              Break the user request into a maximum of ${agentLimit} distinct, granular tasks.
              
              CRITICAL SWARM RULES:
              1. NEVER assign an entire monolithic project to a single agent. Shard the architecture (e.g., UI vs Logic vs Database).
              2. STRICT DEPENDENCY CHAIN: For web interfaces, the HTML/UI task MUST run first. CSS and JS tasks MUST explicitly include the HTML task's ID in their "dependsOn" array. This ensures they read the generated DOM structure and do not hallucinate mismatched classes or IDs.
              3. FILENAME SYNC: You MUST explicitly state the exact filenames in the descriptions (e.g., "Write index.html. Link to styles.css and app.js") so all agents use identical names.
              4. QA AGENT REQUIRED: If the project has 2 or more tasks, your FINAL task MUST be assigned to a "QA Engineer". 
                 - The QA Engineer MUST depend on ALL previous agent outputs.
                 - Their description MUST mandate them to verify that all HTML/CSS/JS files link to each other correctly, verify that JS IDs and CSS classes perfectly match the HTML DOM, fix any junk code, and output the final verified files.
              
              Respond ONLY in strict JSON format:
              {
                "tasks": [
                  { "id": "ui_1", "role": "UI Developer", "description": "Write ONLY the HTML structure in index.html. Link to styles.css and app.js.", "dependsOn": [] },
                  { "id": "style_1", "role": "CSS Developer", "description": "Write ONLY styles.css. Match the classes used in index.html exactly.", "dependsOn": ["ui_1"] },
                  { "id": "logic_1", "role": "JS Developer", "description": "Write ONLY app.js. Target the exact IDs and classes provided in the HTML.", "dependsOn": ["ui_1"] },
                  { "id": "qa_1", "role": "QA Engineer", "description": "Review HTML, CSS, and JS. Fix mismatched DOM classes/IDs. Output final verified files.", "dependsOn": ["ui_1", "style_1", "logic_1"] }
                ]
              }`;

              let planningMessages = [{ role: 'system', content: planPrompt }];
              
              if (history) {
                  history.forEach(msg => {
                      planningMessages.push({ role: msg.role, content: sanitizeHistoryForLLM(msg.content, true) });
                  });
              }
              
              planningMessages.push({ role: 'user', content: finalUserContent });

              const planCompletion = await queenClient.chat.completions.create({
                model: queenTargetName,
                messages: planningMessages,
                response_format: { type: 'json_object' }
              });

              let rawPlanContent = planCompletion.choices[0].message.content;
              
              const jsonStart = rawPlanContent.indexOf('{');
              const jsonEnd = rawPlanContent.lastIndexOf('}');
              if (jsonStart !== -1 && jsonEnd !== -1) {
                  rawPlanContent = rawPlanContent.substring(jsonStart, jsonEnd + 1);
              }
              
              const plan = JSON.parse(rawPlanContent);
              const tasks = plan.tasks.slice(0, agentLimit); 
              
              sendEvent({ t: "proposed_plan", data: tasks });
              
              const messagesToInsert = [
                { chat_id: chatId, role: 'user', content: finalUserContent },
                { chat_id: chatId, role: 'assistant', content: fullAssistantResponse }
              ];
              await supabase.from('messages').insert(messagesToInsert);
              controller.close();
              return;
          }

          // ==========================================
          // PHASE 2: SWARM EXECUTION (PROJECT LEAD APPROVED)
          // ==========================================
          const tasks = activePlan;
          sendEvent({ t: "plan", data: tasks.map(t => ({ id: t.id, role: t.role })) });

          const agentOutputs = {};
          const depPromises = {};
          const resolvers = {};
          
          tasks.forEach(t => depPromises[t.id] = new Promise(r => resolvers[t.id] = r));

          const executeTask = async (task) => {
            try {
              if (task.dependsOn && task.dependsOn.length > 0) {
                await Promise.all(task.dependsOn.map(depId => depPromises[depId]));
              }
              
              let workerModelName = 'deepseek-chat';
              let workerClient = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' });

              if (tier === 'smarter') {
                  workerClient = new OpenAI({ apiKey: process.env.QWEN_API_KEY, baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' });
                  workerModelName = 'qwen-plus';
              } else if (tier === 'smartest') {
                  workerClient = new OpenAI({ apiKey: process.env.QWEN_API_KEY, baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' });
                  workerModelName = 'qwen-max';
              }

              let contextForAgent = "";
              if (task.dependsOn && task.dependsOn.length > 0) {
                contextForAgent = `\n=========================================
                [UPSTREAM DEPENDENCY DATA]
                Here is the verified output from previous agents. 
                CRITICAL: You MUST strictly bind your work to this existing code. Do NOT hallucinate or invent new HTML classes or IDs. Read the provided code below and hook into it perfectly:
                `;
                task.dependsOn.forEach(depId => { if (agentOutputs[depId]) contextForAgent += `\n--- [${depId} Output] ---\n${agentOutputs[depId]}\n`; });
                contextForAgent += "=========================================\n";
              }

              let attempts = 0;
              const maxAttempts = 2;
              let finalTaskOutput = "";
              let agentFeedbackContext = "";

              while (attempts < maxAttempts) {
                sendEvent({ t: "status", id: task.id, status: attempts === 0 ? "thinking" : "revising" });

                const agentPrompt = `You are an expert ${task.role}. 
                Your STRICT, ISOLATED task is: ${task.description}. 
                
                CRITICAL INSTRUCTION - STAY IN YOUR LANE:
                - You must ONLY complete your assigned role. Do NOT fulfill the rest of the user's overall project unless you are the QA Engineer checking everything.
                - Output fully complete, production-ready code.
                
                CRITICAL ARCHITECTURE SYNC (NO MISMATCHED LINKS):
                Below is the Master Plan for this swarm. You MUST use the exact filenames mentioned here when linking files (e.g., <link rel="stylesheet" href="..."> or <script src="...">). Do NOT guess filenames.
                ${JSON.stringify(tasks.map(t => ({ role: t.role, description: t.description })), null, 2)}
                
                CRITICAL PACKAGING INSTRUCTION:
                You MUST package EVERY file you write using this EXACT file block syntax. Do NOT wrap the file blocks inside markdown backticks:
                
                ===FILE: path/to/filename.ext===
                [YOUR CODE HERE]
                ===ENDFILE===

                ${contextForAgent}
                ${agentFeedbackContext}`;

                let currentAttemptOutput = "";
                let isAgentDone = false;
                let agentLoopCount = 0;
                let agentMessages = [
                  { role: 'system', content: agentPrompt },
                  { role: 'user', content: `Original User Request: ${finalUserContent}` }
                ];

                while (!isAgentDone && agentLoopCount < 3) {
                  const agentStream = await workerClient.chat.completions.create({
                    model: workerModelName,
                    messages: agentMessages,
                    stream: true
                  });

                  let chunkTextAcc = "";
                  let finishReason = null;

                  for await (const chunk of agentStream) {
                    const text = chunk.choices[0]?.delta?.content || "";
                    if (chunk.choices[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
                    
                    if (text) {
                      chunkTextAcc += text;
                      currentAttemptOutput += text;
                      sendEvent({ t: "agent_chunk", id: task.id, chunk: text }); 
                    }
                  }

                  if (finishReason === 'length' || finishReason === 'max_tokens') {
                    agentMessages.push({ role: 'assistant', content: chunkTextAcc });
                    agentMessages.push({ role: 'user', content: "Continue exactly where you left off. Do not add any introductory text. Start with the exact next character." });
                    sendEvent({ t: "agent_chunk", id: task.id, chunk: "\n\n*(Auto-Continuing to bypass token limit)*\n\n" });
                    agentLoopCount++;
                  } else {
                    isAgentDone = true;
                  }
                }

                // THE QUEEN'S REVIEW
                sendEvent({ t: "status", id: task.id, status: "reviewing" });
                
                const reviewPrompt = `You are the Queen Orchestrator. Review the output from "${task.role}" for task: "${task.description}".
                1. Did they stay in their lane?
                2. Did they use the ===FILE: === format?
                If good, respond EXACTLY: PASS
                If they failed, respond with: FAIL: [Explain what to fix]`;

                const reviewCompletion = await queenClient.chat.completions.create({
                  model: queenTargetName,
                  messages: [{ role: 'system', content: reviewPrompt }, { role: 'user', content: currentAttemptOutput }]
                });

                const reviewResult = reviewCompletion.choices[0].message.content.trim();

                if (reviewResult.startsWith("PASS") || attempts === maxAttempts - 1) {
                  finalTaskOutput = currentAttemptOutput;
                  break; 
                } else {
                  attempts++;
                  sendEvent({ t: "agent_chunk", id: task.id, chunk: `\n\n> 👑 **Queen Rejected Output:**\n> *${reviewResult}*\n\n> **⚙️ Agent Revising...**\n\n` });
                  agentFeedbackContext = `\n\nYOUR PREVIOUS ATTEMPT FAILED. The Queen said: ${reviewResult}\nFix this immediately.`;
                }
              }

              agentOutputs[task.id] = finalTaskOutput;
              sendEvent({ t: "status", id: task.id, status: "completed" });
              resolvers[task.id](); 

            } catch (e) {
              console.error(`Agent ${task.id} failed:`, e);
              sendEvent({ t: "status", id: task.id, status: "error" });
              resolvers[task.id](); 
            }
          };

          await Promise.all(tasks.map(t => executeTask(t)));

          // ==========================================
          // PHASE 3: QUEEN ASSEMBLY & ZIP PACKAGING
          // ==========================================
          let compiledAgentData = "Raw Verified Agent Work:\n\n";
          for (const [id, output] of Object.entries(agentOutputs)) compiledAgentData += `=== [${id}] ===\n${output}\n\n`;

          const assemblyPrompt = `You are the Queen Orchestrator. The sub-agents and QA Engineer have completed the code.
          
          CRITICAL PACKAGING INSTRUCTION - DO NOT REWRITE CODE: 
          Do NOT rewrite, alter, or output the code generated by the agents. The system will automatically merge their files behind the scenes.
          
          Your ONLY responsibilities are to:
          1. Provide a brief summary of what the swarm accomplished.
          2. Provide a highly detailed README.md file explaining how to run the project.

          If you need to generate a new file (like README.md), use the EXACT text format:
          
          ===FILE: path/to/filename.ext===
          [EXACT VERBATIM CODE]
          ===ENDFILE===`;

          let formattedMessages = [{ role: 'system', content: assemblyPrompt }];
          
          if (history) {
              history.forEach(msg => {
                  formattedMessages.push({ role: msg.role, content: sanitizeHistoryForLLM(msg.content, false) });
              });
          }
          
          formattedMessages.push({ role: 'user', content: `Original Request: ${finalUserContent}\n\n${compiledAgentData}` });

          let isQueenDone = false;
          let queenLoopCount = 0;

          while (!isQueenDone && queenLoopCount < 4) {
            const compileStream = await queenClient.chat.completions.create({
              model: queenTargetName, 
              messages: formattedMessages,
              stream: true,
            });

            let chunkTextAcc = "";
            let finishReason = null;

            for await (const chunk of compileStream) {
              const textChunk = chunk.choices[0]?.delta?.content || "";
              if (chunk.choices[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;

              if (textChunk) {
                chunkTextAcc += textChunk;
                sendEvent({ t: "queen_chunk", chunk: textChunk });
              }
            }

            if (finishReason === 'length' || finishReason === 'max_tokens') {
                formattedMessages.push({ role: 'assistant', content: chunkTextAcc });
                formattedMessages.push({ role: 'user', content: "Continue exactly where you left off. Do not add conversational filler." });
                queenLoopCount++;
            } else {
                isQueenDone = true;
            }
          }

          // PROGRAMMATIC FILE INJECTION (QA OVERRIDE FIX)
          sendEvent({ t: "queen_chunk", chunk: "\n\n---\n### 📦 System Merging Verified Agent Files...\n\n" });
          
          const reversedAgentOutputs = Object.entries(agentOutputs).reverse();
          for (const [id, output] of reversedAgentOutputs) {
              sendEvent({ t: "queen_chunk", chunk: `${output}\n\n` });
          }

        } catch (e) {
          console.error("Agent Orchestration error:", e);
        } finally {
          const messagesToInsert = [
            { chat_id: chatId, role: 'user', content: finalUserContent },
            { chat_id: chatId, role: 'assistant', content: fullAssistantResponse }
          ];
          await supabase.from('messages').insert(messagesToInsert);
          controller.close();
        }
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-New-Title': encodeURIComponent(isFirstMessage ? generatedTitle : '')
      }
    });

  } catch (error) {
    console.error('🔥 Critical Agent API Error:', error);
    return Response.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}