import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function POST(req) {
  try {
    const { chatId, deviceId, newMessage, model } = await req.json();

    if (!chatId || !deviceId || !newMessage) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const selectedModel = model || 'deepseek-v4-flash';
    let finalUserContent = newMessage.content;

    // ==========================================
    // PASS 1: BACKGROUND VISION INTERCEPTOR
    // ==========================================
    if (newMessage.images && newMessage.images.length > 0) {
      try {
        console.log("📸 Image detected! Running background Vision pass via GPT-4o-mini...");
        const visionClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        
        const visionContentArray = [
          { type: 'text', text: 'Analyze this image in extreme detail. Act as the "eyes" for another AI. Extract all visible text, describe layouts, UI elements, code snippets, colors, and overall context so another model can perfectly understand what is going on without seeing it.' }
        ];
        
        newMessage.images.forEach(base64Uri => {
          visionContentArray.push({ type: 'image_url', image_url: { url: base64Uri } });
        });

        const visionResponse = await visionClient.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: visionContentArray }],
        });

        const imageDescription = visionResponse.choices[0].message.content;
        finalUserContent = `[System Attached Image Context:\n${imageDescription}\n]\n\nUser Request: ${finalUserContent}`;
        console.log("✅ Vision extraction successful.");
      } catch (visionError) {
        console.error("❌ Background Vision Pass Failed:", visionError);
        finalUserContent = `[System Error: An image was attached but failed to process through vision module.]\n\nUser Request: ${finalUserContent}`;
      }
    }

    // ==========================================
    // PASS 2: LIVE DATA RAG (WEB SEARCH)
    // ==========================================
    const searchKeywords = ["news", "today", "latest", "search the web", "current"];
    const needsSearch = searchKeywords.some(keyword => newMessage.content.toLowerCase().includes(keyword));

    if (needsSearch && process.env.TAVILY_API_KEY) {
      try {
        console.log("🔍 Live data requested. Fetching Web Context...");
        const tavilyRes = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: process.env.TAVILY_API_KEY,
            query: newMessage.content,
            search_depth: "basic",
            include_answer: true,
            max_results: 3
          })
        });
        const searchData = await tavilyRes.json();
        const liveContext = searchData.results.map(r => `Source: ${r.url}\nContent: ${r.content}`).join("\n\n");
        
        finalUserContent = `[System Live Web Data retrieved just now:\n${liveContext}\n]\n\nUser Request: ${finalUserContent}`;
        console.log("✅ Web Search Context Appended.");
      } catch (searchError) {
        console.error("❌ Web Search Failed:", searchError);
      }
    }

    // ==========================================
    // DATA LAYER & TITLE GENERATION
    // ==========================================
    const { data: history, error: fetchError } = await supabase
      .from('messages')
      .select('role, content')
      .eq('chat_id', chatId)
      .order('created_at', { ascending: true });

    if (fetchError) throw fetchError;
    
    const isFirstMessage = !history || history.length === 0;
    let generatedTitle = "New Chat";

    if (isFirstMessage) {
        try {
            const tempClient = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' });
            const titleCompletion = await tempClient.chat.completions.create({
                model: 'deepseek-chat', 
                messages: [
                    { role: 'system', content: 'Generate a short, 3 to 5 word title for a conversation. Respond ONLY with the title. Do not use quotes.' }, 
                    { role: 'user', content: finalUserContent.substring(0, 500) }
                ],
            });
            generatedTitle = titleCompletion.choices[0].message.content.trim();
        } catch (error) {
            console.error("Title gen failed");
        }
        await supabase.from('chats').upsert([{ id: chatId, device_id: deviceId, title: generatedTitle }], { onConflict: 'id' });
    } else {
        await supabase.from('chats').upsert([{ id: chatId, device_id: deviceId }], { onConflict: 'id', ignoreDuplicates: true });
    }

    // ==========================================
    // PASS 3: PRIMARY MODEL STREAMING EXECUTION
    // ==========================================
    let aiClient;
    let targetModelName = selectedModel;

    if (selectedModel.startsWith('deepseek')) {
      aiClient = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' });
      targetModelName = 'deepseek-chat'; 
    } else if (selectedModel.startsWith('qwen')) {
      aiClient = new OpenAI({ apiKey: process.env.QWEN_API_KEY, baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' });
      if (selectedModel === 'qwen3.7-plus') {
        targetModelName = 'qwen-plus';
      } else if (selectedModel === 'qwen3.7-max') {
        targetModelName = 'qwen-max';
      }
    }

    let formattedMessages = [
      { 
        role: 'system', 
        content: 'You are an expert full-stack developer and helpful assistant. You MUST strictly separate code and text. Always wrap code blocks using standard Markdown triple backticks (```) and specify the language. Never mix plain text inside a code block.\n\n*** AUTONOMOUS PYTHON EXECUTION ***\nYou have an integrated Python execution engine. To write a script and automatically execute it to verify your logic, use the language tag ```python_exec instead of ```python. The system will immediately run the code and return the output/errors to you in the next message. If it errors out, fix the code and use ```python_exec again. Keep looping until successful. When successful, summarize the final result and DO NOT output another python_exec block.' 
      }
    ];

    if (history) {
        history.forEach((msg, index) => {
            // CRITICAL: Ignore purely visual system notifications so the AI doesn't get confused
            if (msg.role === 'info') return;

            let msgContent = msg.content;
            // Scrub older python_exec blocks to save tokens, preserving only the last 2 messages for active context
            if (index < history.length - 2 && msgContent.includes('```python_exec')) {
                msgContent = msgContent.replace(/```python_exec[\s\S]*?```/g, "```python_exec\n# [Previous Code Iteration Hidden to Save Tokens. Refer to your latest code and the error message.]\n```");
            }
            formattedMessages.push({ role: msg.role, content: msgContent });
        });
    }

    formattedMessages.push({ role: 'user', content: finalUserContent });

    const completionStream = await aiClient.chat.completions.create({
      model: targetModelName, 
      messages: formattedMessages,
      stream: true,
    });

    // Create the Readable Stream
    const stream = new ReadableStream({
      async start(controller) {
        let fullAssistantResponse = "";
        
        try {
          for await (const chunk of completionStream) {
            const textChunk = chunk.choices[0]?.delta?.content || "";
            if (textChunk) {
              fullAssistantResponse += textChunk;
              controller.enqueue(new TextEncoder().encode(textChunk));
            }
          }
        } catch (e) {
          console.error("Stream reading error:", e);
          controller.enqueue(new TextEncoder().encode("\n\n[Error: Stream Interrupted]"));
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
    console.error('🔥 Critical Chat API Error:', error);
    return Response.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { chatId, title } = await req.json();
    if (!chatId || !title) return Response.json({ error: 'Missing data' }, { status: 400 });
    await supabase.from('chats').update({ title }).eq('id', chatId);
    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

// Allows persisting inline notifications ('info' role) without hitting AI
export async function PUT(req) {
  try {
    const { chatId, role, content } = await req.json();
    if (!chatId || !role || !content) return Response.json({ error: 'Missing data' }, { status: 400 });
    await supabase.from('messages').insert([{ chat_id: chatId, role, content }]);
    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(req) {
  try {
    const { searchParams } = new URL(req.url);
    const chatId = searchParams.get('chatId');
    await supabase.from('chats').delete().eq('id', chatId);
    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}