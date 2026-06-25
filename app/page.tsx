"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus, prism } from "react-syntax-highlighter/dist/esm/styles/prism";

// --- Global Toast Emitter for Centralized Notifications ---
type Toast = { id: string; msg: string; type: 'success' | 'error' | 'info' };
class ToastEmitter {
  listeners: ((toast: Toast) => void)[] = [];
  emit(msg: string, type: 'success' | 'error' | 'info' = 'info') {
    const id = Date.now().toString() + Math.random().toString();
    this.listeners.forEach(l => l({ id, msg, type }));
  }
  subscribe(l: (toast: Toast) => void) {
    this.listeners.push(l);
    return () => { this.listeners = this.listeners.filter(cb => cb !== l); };
  }
}
const toast = new ToastEmitter();

// --- Types & Parsers ---
type ChatSession = { 
  id: string; 
  title: string; 
  model?: string; 
  isAgentSession?: boolean;
  pinnedContexts?: { id: string; text: string }[];
};
type Message = { role: string; content: string };

const parseMessageData = (content: string) => {
  const fileRegex = /===FILE:\s*(.*?)\s*===(?:\r?\n)?([\s\S]*?)(?:===ENDFILE===|$)/g;
  
  const cleanContent = content.replace(fileRegex, "").trim();

  let match;
  const files: { name: string, content: string }[] = [];
  
  fileRegex.lastIndex = 0; 

  while ((match = fileRegex.exec(content)) !== null) {
    let fileName = match[1]?.trim() || "Untitled";
    let fileContent = match[2]?.trim() || "";
    
    fileContent = fileContent.replace(/^```[\w]*\r?\n/i, ''); 
    fileContent = fileContent.replace(/\r?\n```$/i, ''); 

    if (!files.find(f => f.name === fileName)) {
      files.push({ name: fileName, content: fileContent });
    }
  }
  return { text: cleanContent, files };
};

const parseSwarmMessage = (content: string) => {
  const lines = content.split('\n\n');
  let proposedPlan: {id: string, role: string, description: string}[] | null = null;
  let plan: {id: string, role: string}[] = [];
  let agents: Record<string, { chunk: string, status: string }> = {}; 
  let queenText = "";
  let isSwarm = false;
  
  for (const line of lines) {
      const tLine = line.trim();
      if (!tLine) continue;
      try {
          const ev = JSON.parse(tLine);
          isSwarm = true;
          if (ev.t === 'proposed_plan') {
              proposedPlan = ev.data;
          } else if (ev.t === 'plan') {
              plan = ev.data;
              ev.data.forEach((p: any) => { if(!agents[p.id]) agents[p.id] = { chunk: "", status: "waiting" }; });
          } else if (ev.t === 'status') {
              if (agents[ev.id]) agents[ev.id].status = ev.status;
          } else if (ev.t === 'agent_chunk') {
              if (agents[ev.id]) agents[ev.id].chunk += ev.chunk;
          } else if (ev.t === 'queen_chunk') {
              queenText += ev.chunk;
          }
      } catch(e) {
          // Ignore incomplete JSON chunks
      }
  }
  return isSwarm ? { proposedPlan, plan, agents, queenText } : null;
};

// --- CodeBlock Component ---
const CodeBlock = ({ inline, className, children, theme, ...props }: any) => {
  const match = /language-(\w+)/.exec(className || "");
  const codeString = String(children).replace(/\n$/, "");
  const isMultiLine = codeString.includes("\n");
  const language = match ? match[1] : "text";
  const isPython = language.toLowerCase() === "python" || language.toLowerCase() === "py" || language.toLowerCase() === "python_exec";

  const [output, setOutput] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
      e.preventDefault();
      navigator.clipboard.writeText(codeString);
      toast.emit('Code copied to clipboard', 'success');
  };

  const downloadCode = () => {
      const extMap: Record<string, string> = { javascript: 'js', python: 'py', python_exec: 'py', html: 'html', css: 'css', json: 'json', markdown: 'md', bash: 'sh' };
      const ext = extMap[language.toLowerCase()] || 'txt';
      const blob = new Blob([codeString], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `code_snippet.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.emit(`Saved code_snippet.${ext}`, 'success');
  };

  const runPython = async () => {
      setIsRunning(true);
      setOutput("> Initializing Python environment...\n> Executing script...\n\n");
      
      try {
          const res = await fetch('/api/run-python', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code: codeString })
          });

          const data = await res.json();
          setOutput(prev => prev + `${data.output}\n\n[Process completed]`);

          if (data.files && data.files.length > 0) {
              setOutput(prev => prev + `\n\n> Downloading ${data.files.length} generated file(s)...`);
              
              data.files.forEach((file: any) => {
                  const byteString = atob(file.data);
                  const byteNumbers = new Array(byteString.length);
                  for (let i = 0; i < byteString.length; i++) {
                      byteNumbers[i] = byteString.charCodeAt(i);
                  }
                  const byteArray = new Uint8Array(byteNumbers);
                  const blob = new Blob([byteArray], { type: 'application/octet-stream' });
                  
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = file.name;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
              });
              toast.emit(`Downloaded ${data.files.length} file(s)`, 'success');
          }
      } catch (err: any) {
          setOutput(prev => prev + `Error connecting to execution server: ${err.message}\n\n[Process failed]`);
          toast.emit('Python execution failed', 'error');
      } finally {
          setIsRunning(false);
      }
  };

  const Toolbar = ({ isTop }: { isTop: boolean }) => (
      <div className={`flex items-center justify-between px-5 py-2.5 ${isTop ? 'border-b' : 'border-t'} ${theme === 'dark' ? 'glass-dark border-white/5' : 'glass-light border-black/5'} transition-all`}>
        <span className={`text-[11px] font-mono tracking-widest uppercase ${theme === 'dark' ? 'text-[#888]' : 'text-[#7A7571]'}`}>
            {language === 'python_exec' ? 'PYTHON (AUTO-RUN)' : language}
        </span>
        <div className="flex items-center space-x-4">
          {isPython && isTop && (
              <button onClick={runPython} disabled={isRunning} className={`transition-all duration-300 ease-spring active:scale-95 text-xs flex items-center space-x-1.5 font-mono uppercase tracking-widest ${isRunning ? 'text-indigo-400' : (theme === 'dark' ? 'text-[#888] hover:text-indigo-400' : 'text-[#A0A0A0] hover:text-indigo-600')}`}>
                  {isRunning ? (
                      <svg className="animate-spin h-3.5 w-3.5 text-indigo-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                  ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" /></svg>
                  )}
                  <span>Run</span>
              </button>
          )}
          <button onClick={downloadCode} className={`transition-all duration-300 ease-spring active:scale-95 text-xs flex items-center space-x-1.5 font-mono uppercase tracking-widest ${theme === 'dark' ? 'text-[#888] hover:text-[#E5E5E5]' : 'text-[#A0A0A0] hover:text-[#111]'}`} title="Download Code">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
            <span>Save</span>
          </button>
          <button onClick={handleCopy} className={`transition-all duration-300 ease-spring active:scale-95 text-xs flex items-center space-x-1.5 font-mono uppercase tracking-widest ${theme === 'dark' ? 'text-[#888] hover:text-[#E5E5E5]' : 'text-[#A0A0A0] hover:text-[#111]'}`}>
            <span>Copy</span>
          </button>
        </div>
      </div>
  );

  return (!inline && (match || isMultiLine)) ? (
      <div className="my-8 shadow-2xl rounded-xl overflow-hidden transform-gpu">
          <div className={`relative group/code rounded-xl overflow-hidden ${output ? 'rounded-b-none' : ''} ${theme === 'dark' ? 'glass-dark' : 'glass-light'}`}>
              <Toolbar isTop={true} />
              <SyntaxHighlighter {...props} style={theme === 'dark' ? vscDarkPlus : prism} language={language === 'python_exec' ? 'python' : language} PreTag="div" customStyle={{ margin: 0, padding: "1.5rem", fontSize: "0.875rem", background: "transparent" }}>
                  {codeString}
              </SyntaxHighlighter>
              <Toolbar isTop={false} />
          </div>
          {output && (
              <div className={`relative w-full border-t border-white/5 rounded-b-xl overflow-hidden animate-in slide-in-from-top-2 duration-500 ease-spring ${theme === 'dark' ? 'bg-[#050505]/95 backdrop-blur-2xl' : 'bg-[#111111]/95 backdrop-blur-2xl'}`}>
                  <div className={`px-5 py-2 border-b flex items-center justify-between ${theme === 'dark' ? 'border-[#1A1A1A] bg-[#0A0A0A]/80' : 'border-[#222] bg-[#1A1A1A]/80'}`}>
                      <span className="text-[10px] font-mono tracking-widest uppercase text-[#888]">Terminal Output</span>
                      <button onClick={() => setOutput(null)} className="text-[#888] hover:text-white transition-colors active:scale-95 duration-300 ease-spring">
                          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                      </button>
                  </div>
                  <div className="p-5 font-mono text-[13px] leading-relaxed text-[#00FF41] whitespace-pre-wrap overflow-x-auto max-h-64 overflow-y-auto custom-scrollbar">
                      {output}
                      {isRunning && <span className="inline-block w-2 h-4 ml-1 bg-[#00FF41] animate-pulse align-middle" />}
                  </div>
              </div>
          )}
      </div>
  ) : (
      <code {...props} className={`px-1.5 py-0.5 rounded text-[13px] font-mono tracking-tight ${theme === 'dark' ? 'bg-white/10 text-[#E5E5E5]' : 'bg-black/5 text-[#111111]'}`}>{children}</code>
  );
};

// --- Main Application ---
export default function Home() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatSession[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [pinnedContexts, setPinnedContexts] = useState<{id: string, text: string}[]>([]);
  
  const [chatSearchQuery, setChatSearchQuery] = useState("");
  const [isSearchingChats, setIsSearchingChats] = useState(false);
  const [searchResults, setSearchResults] = useState<ChatSession[] | null>(null);
  
  const [activeModel, setActiveModel] = useState("deepseek-v4-pro");
  const [isAgentMode, setIsAgentMode] = useState(false);
  const [swarmTier, setSwarmTier] = useState<'smart' | 'smarter' | 'smartest'>('smart');
  const [maxAgents, setMaxAgents] = useState(5);
  
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [wasStreaming, setWasStreaming] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  
  const [activeProposedPlan, setActiveProposedPlan] = useState<any[] | null>(null);

  const [isAutoLooping, setIsAutoLooping] = useState(false);
  const cancelAutoRunRef = useRef(false);
  
  const [isGlobalRunning, setIsGlobalRunning] = useState(false);

  const [isUsageModalOpen, setIsUsageModalOpen] = useState(false);
  const [usageData, setUsageData] = useState<{ deepseek?: any, qwen?: any, error?: string } | null>(null);
  const [isLoadingUsage, setIsLoadingUsage] = useState(false);

  const [showOrb, setShowOrb] = useState(false);
  const [typedText, setTypedText] = useState("");
  const fullWelcomeText = "How can I help you today?";
  
  const [chatToDelete, setChatToDelete] = useState<string | null>(null);
  const [activeSessionMenuId, setActiveSessionMenuId] = useState<string | null>(null);
  
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);
  
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
  const [isFilesPanelOpen, setIsFilesPanelOpen] = useState(false);
  const [fileSortOrder, setFileSortOrder] = useState<'name' | 'type'>('name');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editTitleInput, setEditTitleInput] = useState("");

  const [viewingAgent, setViewingAgent] = useState<{msgIndex: number, agentId: string} | null>(null);
  const [activeToasts, setActiveToasts] = useState<Toast[]>([]);
  
  const sidebarRef = useRef<HTMLElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const filesPanelRef = useRef<HTMLDivElement>(null);
  const settingsDropdownRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  
  const [attachments, setAttachments] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [isAutoScrollPaused, setIsAutoScrollPaused] = useState(false);
  const [isInputExpanded, setIsInputExpanded] = useState(false);

  // Subscribe to toasts
  useEffect(() => {
    const unsubscribe = toast.subscribe((newToast) => {
      setActiveToasts(prev => [...prev, newToast]);
      setTimeout(() => {
        setActiveToasts(prev => prev.filter(t => t.id !== newToast.id));
      }, 3500);
    });
    return unsubscribe;
  }, []);

  // Dynamic Browser Tab Title
  useEffect(() => {
    const activeChat = chats.find(c => c.id === activeChatId);
    if (activeChat && activeChat.title && activeChat.title !== "New Chat") {
      document.title = `${activeChat.title} - C-Ai`;
    } else {
      document.title = "C-Ai";
    }
  }, [activeChatId, chats]);

  const filesInChat = useMemo(() => {
    const allFiles = new Map<string, string>();
    messages.forEach(msg => {
      const parsedData = msg.role === 'assistant' ? parseSwarmMessage(msg.content) : null;
      const textToParse = parsedData ? parsedData.queenText : msg.content;
      const { files } = parseMessageData(textToParse);
      
      files.forEach(f => {
        if (!allFiles.has(f.name)) allFiles.set(f.name, f.content);
      });
    });
    return Array.from(allFiles.entries()).map(([name, content]) => ({ name, content }));
  }, [messages]);

  const sortedFilesInChat = useMemo(() => {
    return [...filesInChat].sort((a, b) => {
      if (fileSortOrder === 'name') return a.name.localeCompare(b.name);
      if (fileSortOrder === 'type') {
        const extA = a.name.split('.').pop()?.toLowerCase() || '';
        const extB = b.name.split('.').pop()?.toLowerCase() || '';
        if (extA === extB) return a.name.localeCompare(b.name);
        return extA.localeCompare(extB);
      }
      return 0;
    });
  }, [filesInChat, fileSortOrder]);

  const displayChats = searchResults !== null ? searchResults : chats;

  const lastPythonCode = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === 'assistant') {
            const regex = /```(python|python_exec|py)\n([\s\S]*?)```/g;
            let match;
            let lastCode = null;
            while ((match = regex.exec(msg.content)) !== null) {
                lastCode = match[2];
            }
            if (lastCode) return lastCode;
        }
    }
    return null;
  }, [messages]);

  // SMART INPUT EXPANSION (Hysteresis to prevent flickering)
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      const scrollH = textareaRef.current.scrollHeight;
      const maxH = typeof window !== 'undefined' ? window.innerHeight * 0.5 : 300;
      const newHeight = Math.min(scrollH, maxH);
      textareaRef.current.style.height = `${newHeight}px`;

      // Hysteresis Logic:
      // Once the box expands, keep it expanded until input is fully cleared. 
      // This stops the layout from jittering back to small when full-width makes the text fit on 1 line.
      if (input === "") {
        setIsInputExpanded(false);
      } else if (scrollH > 52 && !isInputExpanded) {
        setIsInputExpanded(true);
      }
    }
  }, [input, isInputExpanded]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(event.target as Node)) setIsModelDropdownOpen(false);
      if (filesPanelRef.current && !filesPanelRef.current.contains(event.target as Node)) setIsFilesPanelOpen(false);
      if (settingsDropdownRef.current && !settingsDropdownRef.current.contains(event.target as Node)) setIsSettingsOpen(false);
      
      if (!(event.target as Element).closest('.session-menu-container')) {
        setActiveSessionMenuId(null);
      }

      const toggleBtn = document.getElementById('sidebar-toggle');
      if (isSidebarOpen && sidebarRef.current && !sidebarRef.current.contains(event.target as Node) && (!toggleBtn || !toggleBtn.contains(event.target as Node))) {
        setIsSidebarOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isSidebarOpen]);

  useEffect(() => {
    if (messages.length === 0) {
      setShowOrb(true);
      setTypedText("");
      let currentText = "";
      const typingSpeed = 80;
      const interval = setInterval(() => {
        if (currentText.length < fullWelcomeText.length) {
          currentText = fullWelcomeText.slice(0, currentText.length + 1);
          setTypedText(currentText);
        } else {
          clearInterval(interval);
        }
      }, typingSpeed);
      return () => clearInterval(interval);
    }
  }, [messages.length, activeChatId]);

  useEffect(() => {
    const storedTheme = localStorage.getItem("c_ai_theme") as 'dark' | 'light';
    if (storedTheme) setTheme(storedTheme);

    const storedAgentMode = localStorage.getItem("c_ai_agent_mode") === 'true';
    setIsAgentMode(storedAgentMode);
    
    const storedSwarmTier = localStorage.getItem("c_ai_swarm_tier") as any;
    if (storedSwarmTier) setSwarmTier(storedSwarmTier);

    const storedMaxAgents = localStorage.getItem("c_ai_max_agents");
    if (storedMaxAgents) setMaxAgents(parseInt(storedMaxAgents, 10));

    let storedDeviceId = localStorage.getItem("c_ai_device_id");
    if (!storedDeviceId) {
      storedDeviceId = "dev_" + Math.random().toString(36).substring(2, 15);
      localStorage.setItem("c_ai_device_id", storedDeviceId);
    }
    setDeviceId(storedDeviceId);

    const storedChats = JSON.parse(localStorage.getItem("c_ai_chats") || "[]");
    setChats(storedChats);
    
    setActiveChatId(crypto.randomUUID());
    setPinnedContexts([]);
    
    if (storedChats.length > 0) {
      const initialModel = storedChats[0].model || "deepseek-v4-pro";
      setActiveModel(initialModel === "gpt-4o-mini" ? "deepseek-v4-flash" : initialModel);
    }
  }, []);

  useEffect(() => {
    if (!activeChatId || !deviceId) return;
    let isMounted = true;
    
    const fetchHistory = async () => {
      try {
        const res = await fetch(`/api/history?chatId=${activeChatId}`);
        if (res.ok && isMounted) {
          const data = await res.json();
          setMessages(prev => (data.messages && data.messages.length > 0) ? data.messages : (prev.length > 0 ? prev : []));
          
          if (data.messages && data.messages.length > 0) {
              const lastMsg = data.messages[data.messages.length - 1];
              if (lastMsg.role === 'assistant') {
                  const parsed = parseSwarmMessage(lastMsg.content);
                  if (parsed && parsed.proposedPlan) {
                      setActiveProposedPlan(parsed.proposedPlan);
                  } else {
                      setActiveProposedPlan(null);
                  }
              }
          }
        }
      } catch (error) { console.error("Failed to fetch history", error); }
    };
    
    fetchHistory();
    return () => { isMounted = false; };
  }, [activeChatId, deviceId]);

  // SMART SCROLLING: Anti-stutter engine & FAB state listener
  const handleScroll = () => {
      if (!chatContainerRef.current) return;
      const { scrollTop, scrollHeight, clientHeight } = chatContainerRef.current;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      // If user scrolls up more than 150px from bottom, pause auto-scroll
      setIsAutoScrollPaused(distanceFromBottom > 150);
  };

  const scrollToBottom = () => {
      setIsAutoScrollPaused(false);
      if (chatContainerRef.current) {
          chatContainerRef.current.scrollTo({ top: chatContainerRef.current.scrollHeight, behavior: 'smooth' });
      } else {
          messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
      }
  };

  useEffect(() => {
      if (!isAutoScrollPaused) {
          if (chatContainerRef.current) {
              // Direct assignment avoids the "scrollIntoView" stutter calculation natively 
              chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
          } else {
              messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
          }
      }
  }, [messages, isStreaming, isAutoScrollPaused]);

  // --- MODEL SWITCH NOTIFICATION SYSTEM ---
  const getModelDescriptor = (model: string, agentMode: boolean, explicitTier?: string) => {
    let name = model.replace(/-/g, ' ').toUpperCase();
    if (model === 'deepseek-v4-flash') name = 'DEEPSEEK FLASH';
    if (model === 'deepseek-v4-pro') name = 'DEEPSEEK PRO';
    if (model === 'qwen3.7-plus') name = 'QWEN 3.7 PLUS';
    if (model === 'qwen3.7-max') name = 'QWEN 3.7 MAX';
    
    if (agentMode) {
        const tierToUse = explicitTier || swarmTier;
        const tierName = tierToUse.charAt(0).toUpperCase() + tierToUse.slice(1);
        return `${name} (${tierName} Swarm)`;
    }
    return name;
  }

  const injectModelSwitchNotification = async (oldDesc: string, newDesc: string) => {
    if (!activeChatId || messages.length === 0) return;
    const content = `${oldDesc} ➞ ${newDesc}`;
    
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role === 'info' && lastMsg.content === content) return;

    const newMsg = { role: "info", content };
    setMessages(prev => [...prev, newMsg as any]);
    
    try {
        await fetch('/api/chat', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId: activeChatId, role: 'info', content })
        });
    } catch (e) {}
  }
  // ----------------------------------------

  const forceStopAutoRun = () => {
      cancelAutoRunRef.current = true;
      setIsAutoLooping(false);
      toast.emit('Execution loop stopped', 'info');
  };

  const fetchUsage = async () => {
      setIsLoadingUsage(true);
      try {
          const res = await fetch('/api/usage');
          const data = await res.json();
          setUsageData(data);
      } catch (e) {
          setUsageData({ error: 'Failed to communicate with the server to fetch usage data.' });
          toast.emit('Failed to fetch usage data', 'error');
      } finally {
          setIsLoadingUsage(false);
      }
  };

  const executeApprovedPlan = () => {
      if (!activeProposedPlan) return;
      sendMessage(undefined, "Approved. Proceed with execution.", true, activeProposedPlan);
  };

  const runGlobalPython = async (code: string) => {
    setIsGlobalRunning(true);
    toast.emit('Executing script...', 'info');
    try {
        const res = await fetch('/api/run-python', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code })
        });
        const data = await res.json();
        
        if (data.files && data.files.length > 0) {
            data.files.forEach((file: any) => {
                const byteString = atob(file.data);
                const byteNumbers = new Array(byteString.length);
                for (let i = 0; i < byteString.length; i++) byteNumbers[i] = byteString.charCodeAt(i);
                const byteArray = new Uint8Array(byteNumbers);
                const blob = new Blob([byteArray], { type: 'application/octet-stream' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = file.name;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            });
            toast.emit(`Downloaded ${data.files.length} generated file(s)`, 'success');
        } else {
            toast.emit('Script executed successfully (no files generated)', 'success');
        }
    } catch (err: any) {
        toast.emit(`Execution failed: ${err.message}`, 'error');
    } finally {
        setIsGlobalRunning(false);
    }
  };

  const sendMessage = async (e?: React.FormEvent, overrideInput?: string, forceExecute: boolean = false, planToExecute: any[] | null = null) => {
    if (e) e.preventDefault();
    
    const textToProcess = overrideInput || input;
    if ((!textToProcess.trim() && attachments.length === 0) || !deviceId || !activeChatId) return;

    const isNaturalApproval = /^(ok|proceed|make it happen|yes|do it|approve|execute)$/i.test(textToProcess.trim());
    const isExecutionPhase = forceExecute || (activeProposedPlan && isNaturalApproval);
    const planForPayload = isExecutionPhase ? (planToExecute || activeProposedPlan) : null;

    // Reset auto scroll pause on new message sent
    setIsAutoScrollPaused(false);
    setIsLoading(true);
    setIsStreaming(false);
    let combinedFileText = "";
    const base64Images: string[] = [];

    if (!overrideInput && attachments.length > 0) {
      for (const file of attachments) {
        const isImage = /\.(png|jpe?g|webp)$/i.test(file.name);
        if (file.type === "application/pdf" || file.name.endsWith(".pdf")) {
          try {
            const formData = new FormData();
            formData.append("file", file);
            const res = await fetch("/api/parse-pdf", { method: "POST", body: formData });
            const data = await res.json();
            if (data.text) combinedFileText += `\n===FILE: ${file.name}===\n${data.text}\n===ENDFILE===\n`;
          } catch (err) { toast.emit(`Failed to parse PDF: ${file.name}`, 'error'); }
        } else if (isImage) {
          try {
            const base64Str = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = (e) => resolve(e.target?.result as string);
              reader.onerror = reject;
              reader.readAsDataURL(file);
            });
            base64Images.push(base64Str);
            combinedFileText += `\n[Attached Image: ${file.name}]\n`;
          } catch (err) { toast.emit(`Failed to process image`, 'error'); }
        } else {
          try {
            const text = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = (e) => resolve(e.target?.result as string);
              reader.onerror = (e) => reject(e);
              reader.readAsText(file);
            });
            combinedFileText += `\n===FILE: ${file.name}===\n${text}\n===ENDFILE===\n`;
          } catch (err) { toast.emit(`Failed to read file`, 'error'); }
        }
      }
    }

    const displayInputContent = combinedFileText ? `${textToProcess}\n${combinedFileText}` : textToProcess;

    const newMessage = { 
      role: "user", 
      content: displayInputContent,
      ...((base64Images.length > 0) ? { images: base64Images } : {})
    };
    
    let currentChats = chats;
    if (!chats.some(c => c.id === activeChatId)) {
      const newChatObj: ChatSession = { id: activeChatId, title: "New Chat", model: activeModel, isAgentSession: isAgentMode, pinnedContexts };
      currentChats = [newChatObj, ...chats];
      setChats(currentChats);
      localStorage.setItem("c_ai_chats", JSON.stringify(currentChats));
    }

    setMessages((prev) => [...prev, { role: "user", content: displayInputContent }]);
    setActiveProposedPlan(null); 
    
    if (!overrideInput) {
        setInput("");
        setAttachments([]); 
        setIsModelDropdownOpen(false); 
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
        setIsInputExpanded(false); // Explicitly reset expansion
    }

    try {
      const endpoint = isAgentMode ? "/api/agent" : "/api/chat";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId: activeChatId,
          deviceId,
          newMessage,
          model: activeModel,
          pinnedContexts: pinnedContexts.map(p => p.text),
          ...(isAgentMode && { 
              isAgentMode: true, 
              swarmTier, 
              maxAgents,
              swarmPhase: isExecutionPhase ? 'execute' : 'plan',
              activePlan: planForPayload
          })
        }),
      });

      if (!res.ok) {
        const errorData = await res.json();
        setMessages((prev) => [...prev, { role: "assistant", content: `### Execution Error\n\`\`\`json\n${JSON.stringify(errorData, null, 2)}\n\`\`\`` }]);
        toast.emit('Execution Error occurred', 'error');
        setIsLoading(false);
        return;
      }

      const encodedTitle = res.headers.get("X-New-Title");
      if (encodedTitle) {
        const newTitle = decodeURIComponent(encodedTitle);
        if (newTitle) {
          setChats(prevChats => {
            const updated = prevChats.map(c => c.id === activeChatId ? { ...c, title: newTitle } : c);
            localStorage.setItem("c_ai_chats", JSON.stringify(updated));
            return updated;
          });
        }
      }

      setIsLoading(false);
      setIsStreaming(true);
      
      const reader = res.body?.getReader();
      const decoder = new TextDecoder("utf-8");
      
      let finalAssitantMessage = "";

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunkText = decoder.decode(value, { stream: true });
          finalAssitantMessage += chunkText;
          
          setMessages((prev) => {
            if (prev.length === 0) return [{ role: "assistant", content: chunkText }];
            const newMessages = [...prev];
            const lastIndex = newMessages.length - 1;
            const lastMsg = newMessages[lastIndex];
            
            if (lastMsg.role !== "assistant") {
              newMessages.push({ role: "assistant", content: chunkText });
            } else {
              newMessages[lastIndex] = { ...lastMsg, content: lastMsg.content + chunkText };
            }
            return newMessages;
          });
        }
      }
      setIsStreaming(false);

      if (isAgentMode) {
          const parsedFinal = parseSwarmMessage(finalAssitantMessage);
          if (parsedFinal && parsedFinal.proposedPlan) {
              setActiveProposedPlan(parsedFinal.proposedPlan);
              toast.emit('New plan proposed by Swarm', 'info');
          }
      }

    } catch (error) {
      console.error("Error sending message:", error);
      toast.emit('Network error occurred', 'error');
      setIsLoading(false);
      setIsStreaming(false);
    }
  };

  const executePythonAndContinue = async (content: string) => {
      setIsAutoLooping(true);
      cancelAutoRunRef.current = false;

      const regex = /```python_exec\n([\s\S]*?)```/g;
      let match;
      let code = "";
      while ((match = regex.exec(content)) !== null) {
          code = match[1]; 
      }

      if (!code) {
          setIsAutoLooping(false);
          return;
      }

      try {
          const res = await fetch('/api/run-python', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code })
          });
          const data = await res.json();
          let outputStr = data.output || "";

          if (outputStr.length > 3000) {
              outputStr = outputStr.substring(0, 1500) + "\n...[OUTPUT TRUNCATED]...\n" + outputStr.substring(outputStr.length - 1500);
          }

          let resultText = `[Autonomous Execution Result]\n${outputStr}`;
          
          if (!outputStr.toLowerCase().includes('error') && !outputStr.toLowerCase().includes('traceback')) {
              // Automatically trigger download on successful auto-run
              if (data.files && data.files.length > 0) {
                  data.files.forEach((file: any) => {
                      const byteString = atob(file.data);
                      const byteNumbers = new Array(byteString.length);
                      for (let i = 0; i < byteString.length; i++) byteNumbers[i] = byteString.charCodeAt(i);
                      const byteArray = new Uint8Array(byteNumbers);
                      const blob = new Blob([byteArray], { type: 'application/octet-stream' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = file.name;
                      document.body.appendChild(a);
                      a.click();
                      document.body.removeChild(a);
                      URL.revokeObjectURL(url);
                  });
                  toast.emit(`Auto-downloaded ${data.files.length} generated file(s)`, 'success');
                  resultText += `\n(Generated files: ${data.files.map((f:any)=>f.name).join(', ')})`;
              }
          }

          if (outputStr.toLowerCase().includes('error') || outputStr.toLowerCase().includes('traceback')) {
               resultText += `\n\nExecution failed. Please analyze the error and provide ONLY the fully corrected code in a new \`\`\`python_exec block. Do not look at older code blocks, just use the error above to fix your immediate last version. Do not provide explanations outside the block to save space.`;
          } else {
               resultText += `\n\nExecution successful! If the goal is met, summarize the final result and DO NOT output another \`\`\`python_exec block. If further steps are needed, output the next \`\`\`python_exec block.`;
          }

          if (!cancelAutoRunRef.current) {
              await sendMessage(undefined, resultText);
          } else {
              setIsAutoLooping(false);
          }

      } catch (e: any) {
          if (!cancelAutoRunRef.current) {
              await sendMessage(undefined, `[Autonomous Execution Failed]\nSystem Error: ${e.message}\nPlease try an alternative approach using \`\`\`python_exec.`);
          } else {
              setIsAutoLooping(false);
          }
      }
  };

  useEffect(() => {
    if (wasStreaming && !isStreaming && messages.length > 0) {
      const lastMsgElement = document.getElementById(`message-${messages.length - 1}`);
      if (lastMsgElement) {
        setTimeout(() => {
          lastMsgElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 100);
      }

      const lastMsg = messages[messages.length - 1];
      if (lastMsg.role === 'assistant' && lastMsg.content.includes('```python_exec')) {
          if (cancelAutoRunRef.current) {
              cancelAutoRunRef.current = false;
              setIsAutoLooping(false);
          } else {
              executePythonAndContinue(lastMsg.content);
          }
      } else {
          setIsAutoLooping(false);
      }
    }
    setWasStreaming(isStreaming);
  }, [isStreaming, messages.length, wasStreaming]);

  const executeChatSearch = async () => {
    if (!chatSearchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    setIsSearchingChats(true);
    
    try {
      await new Promise(resolve => setTimeout(resolve, 600)); 
      const lowerQ = chatSearchQuery.toLowerCase();
      const results = chats.filter(c => c.title.toLowerCase().includes(lowerQ));
      setSearchResults(results);
    } catch (e) {
      console.error(e);
    } finally {
      setIsSearchingChats(false);
    }
  };

  const updatePinnedContexts = (updater: (prev: {id: string, text: string}[]) => {id: string, text: string}[]) => {
    setPinnedContexts(prev => {
        const newPins = updater(prev);
        setChats(prevChats => {
            const updated = prevChats.map(c => c.id === activeChatId ? { ...c, pinnedContexts: newPins } : c);
            localStorage.setItem("c_ai_chats", JSON.stringify(updated));
            return updated;
        });
        return newPins;
    });
  };

  const handlePinMessage = (text: string) => {
    updatePinnedContexts(prev => {
        if(prev.find(p => p.text === text)) return prev;
        toast.emit('Context pinned', 'success');
        return [...prev, { id: crypto.randomUUID(), text }];
    });
  };

  const removePin = (id: string) => {
    updatePinnedContexts(prev => prev.filter(p => p.id !== id));
    toast.emit('Pin removed', 'info');
  };

  const createNewChat = () => {
    setActiveChatId(crypto.randomUUID());
    setMessages([]);
    setPinnedContexts([]);
    setActiveProposedPlan(null);
    setIsSidebarOpen(false);
  };

  const updateChatModel = (newModel: string) => {
    const oldDesc = getModelDescriptor(activeModel, isAgentMode);
    const newDesc = getModelDescriptor(newModel, isAgentMode);
    if (oldDesc !== newDesc && messages.length > 0) {
        injectModelSwitchNotification(oldDesc, newDesc);
    }
    setActiveModel(newModel);
    const updatedChats = chats.map(c => c.id === activeChatId ? { ...c, model: newModel } : c);
    setChats(updatedChats);
    localStorage.setItem("c_ai_chats", JSON.stringify(updatedChats));
  };

  const updateAgentModeSettings = (mode: boolean) => {
    const oldDesc = getModelDescriptor(activeModel, isAgentMode);
    const nextModel = (mode && activeModel === 'deepseek-v4-flash') ? 'deepseek-v4-pro' : activeModel;
    const newDesc = getModelDescriptor(nextModel, mode);
    if (oldDesc !== newDesc && messages.length > 0) {
        injectModelSwitchNotification(oldDesc, newDesc);
    }

    setIsAgentMode(mode);
    localStorage.setItem("c_ai_agent_mode", String(mode));
    if (mode && activeModel === 'deepseek-v4-flash') {
        setActiveModel('deepseek-v4-pro');
        const updatedChats = chats.map(c => c.id === activeChatId ? { ...c, model: 'deepseek-v4-pro', isAgentSession: true } : c);
        setChats(updatedChats);
        localStorage.setItem("c_ai_chats", JSON.stringify(updatedChats));
    } else {
        const updatedChats = chats.map(c => c.id === activeChatId ? { ...c, isAgentSession: mode } : c);
        setChats(updatedChats);
        localStorage.setItem("c_ai_chats", JSON.stringify(updatedChats));
    }
  };

  const updateSwarmTier = (tier: 'smart' | 'smarter' | 'smartest') => {
    const oldDesc = getModelDescriptor(activeModel, isAgentMode);
    setSwarmTier(tier);
    localStorage.setItem("c_ai_swarm_tier", tier);
    
    const newDesc = getModelDescriptor(activeModel, isAgentMode, tier);
    if (oldDesc !== newDesc && messages.length > 0) {
        injectModelSwitchNotification(oldDesc, newDesc);
    }
  };

  const updateMaxAgents = (val: number) => {
    setMaxAgents(val);
    localStorage.setItem("c_ai_max_agents", String(val));
  };

  const confirmDeleteChat = async () => {
    if (!chatToDelete) return;
    try {
      await fetch(`/api/chat?chatId=${chatToDelete}`, { method: "DELETE" });
      const updatedChats = chats.filter(c => c.id !== chatToDelete);
      setChats(updatedChats);
      localStorage.setItem("c_ai_chats", JSON.stringify(updatedChats));
      toast.emit('Conversation deleted', 'info');
      
      if (activeChatId === chatToDelete) {
        if (updatedChats.length > 0) {
          setActiveChatId(updatedChats[0].id);
          setActiveModel(updatedChats[0].model || "deepseek-v4-pro");
          setPinnedContexts(updatedChats[0].pinnedContexts || []);
          setActiveProposedPlan(null);
        } else createNewChat();
      }
    } catch (error) { toast.emit("Error deleting chat", "error"); } 
    finally { 
      setChatToDelete(null); 
      setActiveSessionMenuId(null);
    }
  };

  const selectChat = (id: string) => {
    setActiveChatId(id);
    setActiveProposedPlan(null);
    const chat = chats.find(c => c.id === id);
    if (chat) {
      if (chat.model) setActiveModel(chat.model === "gpt-4o-mini" ? "deepseek-v4-flash" : chat.model);
      if (chat.isAgentSession !== undefined) setIsAgentMode(chat.isAgentSession);
      setPinnedContexts(chat.pinnedContexts || []);
    }
    setIsSidebarOpen(false);
  };

  const downloadFile = (filename: string, content: string) => {
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename.split('/').pop() || filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.emit(`Downloaded ${filename}`, 'success');
  };

  const downloadProjectZip = async (files: {name: string, content: string}[], projectName: string) => {
    try {
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();
      
      files.forEach(f => {
        zip.file(f.name, f.content);
      });
      
      const content = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(content);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${projectName.replace(/\s+/g, '_')}_Source.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.emit('Project ZIP Downloaded', 'success');
    } catch (e) {
      toast.emit("Failed to generate ZIP. Ensure 'jszip' is installed.", "error");
    }
  };

  const copyMessageToClipboard = (text: string, index: number) => {
    navigator.clipboard.writeText(text);
    toast.emit('Copied to clipboard', 'success');
  };
  
  const startEditingTitle = (id: string, title: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingChatId(id);
    setEditTitleInput(title);
    setActiveSessionMenuId(null);
  };

  const saveEditedTitle = async (chatId: string, e?: React.FormEvent | React.FocusEvent) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (!editTitleInput.trim() || !chatId) { setEditingChatId(null); return; }

    const updatedChats = chats.map(c => c.id === chatId ? { ...c, title: editTitleInput } : c);
    setChats(updatedChats);
    localStorage.setItem("c_ai_chats", JSON.stringify(updatedChats));
    setEditingChatId(null);

    try {
      await fetch("/api/chat", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, title: editTitleInput }) });
    } catch (error) { toast.emit("Error updating chat title", "error"); }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) setAttachments(prev => [...prev, ...Array.from(e.target.files!)]);
    e.target.value = '';
  };
  const removeAttachment = (index: number) => setAttachments(prev => prev.filter((_, i) => i !== index));
  const handleDragEnter = (e: React.DragEvent) => { e.preventDefault(); dragCounter.current += 1; if (e.dataTransfer.items && e.dataTransfer.items.length > 0) setIsDragging(true); };
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); dragCounter.current -= 1; if (dragCounter.current === 0) setIsDragging(false); };
  const handleDragOver = (e: React.DragEvent) => e.preventDefault();
  const handleDrop = (e: React.DragEvent) => { e.preventDefault(); dragCounter.current = 0; setIsDragging(false); if (e.dataTransfer.files && e.dataTransfer.files.length > 0) setAttachments(prev => [...prev, ...Array.from(e.dataTransfer.files!)]); };

  const getCopyIcon = () => (
      <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
  );

  const getPinIcon = () => (
    <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 17v5"></path><path d="M9 10.5V17h6v-6.5l2-2.5V3H7v1.5l2 2.5z"></path></svg>
  );

  const markdownComponents = useMemo(() => ({
    h1({ children }: any) { return <h1 className={`text-3xl md:text-4xl font-semibold tracking-tight mt-10 mb-6 ${theme === 'dark' ? 'text-[#F4F4F5]' : 'text-[#18181B]'}`}>{children}</h1>; },
    h2({ children }: any) { return <h2 className={`text-2xl md:text-3xl font-medium tracking-tight mt-10 mb-5 ${theme === 'dark' ? 'text-[#F4F4F5]' : 'text-[#18181B]'}`}>{children}</h2>; },
    h3({ children }: any) { return <h3 className={`text-xl font-medium mt-8 mb-4 ${theme === 'dark' ? 'text-[#E4E4E7]' : 'text-[#27272A]'}`}>{children}</h3>; },
    h4({ children }: any) { return <h4 className={`text-lg font-medium mt-8 mb-4 ${theme === 'dark' ? 'text-[#E4E4E7]' : 'text-[#27272A]'}`}>{children}</h4>; },
    strong({ children }: any) { return <strong className={`font-semibold ${theme === 'dark' ? 'text-[#F4F4F5]' : 'text-[#18181B]'}`}>{children}</strong>; },
    em({ children }: any) { return <em className="italic opacity-90">{children}</em>; },
    ul({ children }: any) { return <ul className="list-disc list-outside ml-6 mb-6 space-y-2 text-[15px]">{children}</ul>; },
    ol({ children }: any) { return <ol className="list-decimal list-outside ml-6 mb-6 space-y-2 text-[15px]">{children}</ol>; },
    li({ children }: any) { return <li className="leading-relaxed pl-2">{children}</li>; },
    blockquote({ children }: any) { return <blockquote className={`border-l-2 pl-6 py-1 my-6 italic ${theme === 'dark' ? 'border-[#52525B] text-[#A1A1AA]' : 'border-[#D4D4D8] text-[#71717A]'}`}>{children}</blockquote>; },
    hr() { return <hr className={`my-10 border-t ${theme === 'dark' ? 'border-white/10' : 'border-black/10'}`} />; },
    p({ children }: any) { return <p className="mb-6 last:mb-0 text-[15px] leading-[1.8]">{children}</p>; },
    table({ children }: any) { return <div className="overflow-x-auto w-full my-8"><table className={`w-full text-left border-collapse text-sm ${theme === 'dark' ? 'text-[#D4D4D8]' : 'text-[#3F3F46]'}`}>{children}</table></div>; },
    thead({ children }: any) { return <thead className={`text-xs uppercase tracking-widest ${theme === 'dark' ? 'bg-[#18181B] text-[#A1A1AA] border-b border-[#27272A]' : 'bg-[#F4F4F5] text-[#71717A] border-b border-[#E4E4E7]'}`}>{children}</thead>; },
    th({ children }: any) { return <th className="px-5 py-4 font-medium whitespace-nowrap">{children}</th>; },
    td({ children }: any) { return <td className={`px-5 py-4 border-b ${theme === 'dark' ? 'border-[#27272A]' : 'border-[#E4E4E7]'} whitespace-nowrap`}>{children}</td>; },
    tbody({ children }: any) { return <tbody>{children}</tbody>; },
    code(props: any) {
        return <CodeBlock theme={theme} {...props}/>;
    }
  }), [theme]);

  return (
    <>
      <style jsx global>{`
        /* Global Typography tweaks for Minimalist feel */
        body { 
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            -webkit-font-smoothing: antialiased; 
            -moz-osx-font-smoothing: grayscale; 
            background-color: ${theme === 'dark' ? '#0A0A0A' : '#FAFAFA'}; 
        }

        /* Ambient Noise Overlay */
        .bg-noise {
           background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='[http://www.w3.org/2000/svg'%3E%3Cfilter](http://www.w3.org/2000/svg'%3E%3Cfilter) id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)' opacity='0.04'/%3E%3C/svg%3E");
           pointer-events: none;
           position: fixed;
           inset: 0;
           z-index: 5;
           opacity: ${theme === 'dark' ? '0.04' : '0.08'};
        }

        /* Liquid Glass Aesthetics */
        .glass-dark {
            background: rgba(18, 18, 20, 0.65);
            backdrop-filter: blur(24px) saturate(180%);
            box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.08), 0 8px 32px rgba(0, 0, 0, 0.4);
            border: 1px solid rgba(255, 255, 255, 0.05);
        }
        .glass-light {
            background: rgba(253, 253, 253, 0.7);
            backdrop-filter: blur(24px) saturate(180%);
            box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.4), 0 8px 32px rgba(0, 0, 0, 0.04);
            border: 1px solid rgba(0, 0, 0, 0.05);
        }

        /* Solid Glass overlays specifically for dropdowns */
        .glass-dark-solid {
            background: rgba(18, 18, 20, 0.95);
            backdrop-filter: blur(32px) saturate(200%);
            box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.1), 0 10px 40px rgba(0, 0, 0, 0.6);
            border: 1px solid rgba(255, 255, 255, 0.1);
        }
        .glass-light-solid {
            background: rgba(253, 253, 253, 0.95);
            backdrop-filter: blur(32px) saturate(200%);
            box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.6), 0 10px 40px rgba(0, 0, 0, 0.1);
            border: 1px solid rgba(0, 0, 0, 0.1);
        }

        /* Spring Animations */
        .ease-spring { transition-timing-function: cubic-bezier(0.25, 1, 0.3, 1); }

        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: ${theme === 'dark' ? 'rgba(156, 163, 175, 0.2)' : 'rgba(122, 117, 113, 0.3)'}; border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: ${theme === 'dark' ? 'rgba(156, 163, 175, 0.5)' : 'rgba(122, 117, 113, 0.6)'}; }
        
        @keyframes aurora-vector-1 { 0% { transform: translate(0px, 0px) scale(1) rotate(0deg); } 50% { transform: translate(60px, 40px) scale(1.15) rotate(180deg); } 100% { transform: translate(0px, 0px) scale(1) rotate(360deg); } }
        @keyframes aurora-vector-2 { 0% { transform: translate(0px, 0px) scale(1.1) rotate(0deg); } 50% { transform: translate(-50px, -60px) scale(0.9) rotate(-180deg); } 100% { transform: translate(0px, 0px) scale(1.1) rotate(-360deg); } }
        .animate-aurora-1 { animation: aurora-vector-1 40s infinite linear; }
        .animate-aurora-2 { animation: aurora-vector-2 45s infinite linear; }
        @keyframes fluid-morph { 0% { border-radius: 60% 40% 30% 70% / 60% 30% 70% 40%; transform: translate(0, 0) rotate(0deg); } 33% { border-radius: 40% 60% 70% 30% / 40% 50% 60% 50%; transform: translate(4px, 4px) rotate(120deg); } 66% { border-radius: 70% 30% 50% 50% / 30% 60% 40% 70%; transform: translate(-4px, -4px) rotate(240deg); } 100% { border-radius: 60% 40% 30% 70% / 60% 30% 70% 40%; transform: translate(0, 0) rotate(360deg); } }
        .animate-fluid { animation: fluid-morph 8s ease-in-out infinite; }
        .custom-scrollbar::-webkit-scrollbar { width: 3px; height: 3px; }
        
        @keyframes marquee-scroll {
            0%, 5% { transform: translateX(0); }
            95%, 100% { transform: translateX(calc(-100% + 140px)); }
        }
        .marquee-mask {
            mask-image: linear-gradient(to right, black 80%, transparent 100%);
            -webkit-mask-image: linear-gradient(to right, black 80%, transparent 100%);
        }
        .marquee-inner {
            display: inline-block;
            white-space: nowrap;
            transition: transform 0s;
        }
        .group:hover .marquee-inner {
            animation: marquee-scroll 4s linear 3s infinite alternate;
        }
      `}</style>

      {/* Global Background Noise Texture */}
      <div className="bg-noise" />

      {/* Centralized Toasts Container */}
      <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[300] flex flex-col items-center pointer-events-none space-y-3">
        {activeToasts.map(t => (
          <div key={t.id} className={`pointer-events-auto flex items-center gap-3 px-6 py-3 rounded-full shadow-2xl animate-in fade-in slide-in-from-top-4 duration-500 ease-spring ${theme === 'dark' ? 'glass-dark text-white' : 'glass-light text-black'}`}>
            {t.type === 'success' && <svg className="w-4 h-4 text-emerald-500" xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" /></svg>}
            {t.type === 'error' && <svg className="w-4 h-4 text-rose-500" xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clipRule="evenodd" /></svg>}
            {t.type === 'info' && <svg className="w-4 h-4 text-indigo-500" xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clipRule="evenodd" /></svg>}
            <span className="text-[13px] font-medium tracking-wide">{t.msg}</span>
          </div>
        ))}
      </div>

      {viewingAgent && (() => {
        const msg = messages[viewingAgent.msgIndex];
        const swarmData = msg ? parseSwarmMessage(msg.content) : null;
        const agent = swarmData?.agents[viewingAgent.agentId];
        const role = swarmData?.plan.find(p => p.id === viewingAgent.agentId)?.role || "Agent";
        
        return (
          <div className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-xl flex justify-end p-4 md:p-6 animate-in fade-in duration-500 ease-spring" onClick={() => setViewingAgent(null)}>
            <div className={`w-full md:w-[600px] lg:w-[750px] h-full flex flex-col rounded-3xl shadow-2xl overflow-hidden transition-all duration-500 ease-spring translate-x-0 ${theme === 'dark' ? 'glass-dark-solid' : 'glass-light-solid'}`} onClick={e => e.stopPropagation()}>
              <div className={`px-8 py-6 border-b flex items-center justify-between flex-shrink-0 ${theme === 'dark' ? 'border-white/5 bg-black/20' : 'border-black/5 bg-white/20'}`}>
                <div className="flex items-center gap-4">
                  {agent?.status === 'thinking' && <div className="w-3 h-3 rounded-full bg-indigo-500 animate-pulse shadow-[0_0_10px_rgba(99,102,241,0.5)]" />}
                  {agent?.status === 'reviewing' && <div className="w-3 h-3 rounded-full bg-orange-500 animate-ping shadow-[0_0_10px_rgba(249,115,22,0.5)]" />}
                  {agent?.status === 'revising' && <div className="w-3 h-3 rounded-full bg-rose-500 animate-pulse shadow-[0_0_10px_rgba(244,63,94,0.5)]" />}
                  {agent?.status === 'completed' && <div className="w-3 h-3 rounded-full bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]" />}
                  {agent?.status === 'waiting' && <div className="w-3 h-3 rounded-full bg-gray-500" />}
                  
                  <h3 className={`text-lg font-medium tracking-wide ${theme === 'dark' ? 'text-white' : 'text-black'}`}>{role}</h3>
                  <span className={`text-[10px] uppercase tracking-widest px-2.5 py-1 rounded-full border ${
                    agent?.status === 'reviewing' ? 'border-orange-500/50 text-orange-500' :
                    agent?.status === 'revising' ? 'border-rose-500/50 text-rose-500' :
                    theme === 'dark' ? 'border-white/10 text-[#888]' : 'border-black/10 text-[#7A7571]'
                  }`}>{agent?.status}</span>
                </div>
                <button onClick={() => setViewingAgent(null)} className={`p-2 rounded-full transition-all duration-300 active:scale-90 ${theme === 'dark' ? 'hover:bg-white/10 text-[#888] hover:text-white' : 'hover:bg-black/5 text-[#7A7571] hover:text-black'}`}>
                  <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-8 py-8 scroll-smooth">
                {agent?.chunk ? (
                  <div className={`prose max-w-none prose-p:leading-relaxed prose-pre:bg-transparent prose-pre:p-0 prose-pre:my-6 ${theme === 'dark' ? 'prose-invert prose-p:text-[#D4D4D4]' : 'prose-p:text-[#3F3F46]'}`}>
                    <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
                      {agent.chunk}
                    </ReactMarkdown>
                    {['thinking', 'revising'].includes(agent.status) && (
                      <span className="inline-block w-2 h-4 ml-1 bg-indigo-500 animate-pulse align-middle" />
                    )}
                  </div>
                ) : (
                  <div className="h-full flex items-center justify-center flex-col opacity-50">
                    <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-10 h-10 mb-4 animate-spin-slow"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>
                    <p className="text-sm font-light">Waiting for dependencies to finish...</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* USAGE MODAL */}
      {isUsageModalOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-xl p-4 animate-in fade-in duration-500 ease-spring" onClick={() => setIsUsageModalOpen(false)}>
          <div className={`w-full max-w-md p-8 rounded-3xl shadow-2xl ${theme === 'dark' ? 'glass-dark-solid' : 'glass-light-solid'}`} onClick={e => e.stopPropagation()}>
              <div className="flex justify-between items-center mb-8">
                  <h3 className={`text-lg font-medium tracking-wide ${theme === 'dark' ? 'text-white' : 'text-[#111]'}`}>API Usage</h3>
                  <button onClick={() => setIsUsageModalOpen(false)} className={`p-2 rounded-full transition-all active:scale-90 ${theme === 'dark' ? 'hover:bg-white/10 text-[#888] hover:text-white' : 'hover:bg-black/5 text-[#7A7571] hover:text-black'}`}>
                      <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
              </div>

              {isLoadingUsage ? (
                  <div className="flex flex-col items-center justify-center py-10 opacity-50">
                      <svg className="animate-spin h-8 w-8 text-indigo-500 mb-4" xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                      <span className="text-xs tracking-widest uppercase font-mono">Fetching Balances...</span>
                  </div>
              ) : (
                  <div className="space-y-4">
                      <div className={`p-5 rounded-2xl ${theme === 'dark' ? 'bg-black/20 border border-white/5' : 'bg-white/40 border border-black/5'}`}>
                          <div className="flex items-center gap-3 mb-4">
                              <div className="w-3 h-3 rounded-full bg-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.5)]"></div>
                              <h4 className={`text-sm font-bold tracking-wider uppercase ${theme === 'dark' ? 'text-[#E5E5E5]' : 'text-[#333]'}`}>DeepSeek</h4>
                          </div>
                          {usageData?.deepseek?.error ? (
                              <p className={`text-xs ${theme === 'dark' ? 'text-rose-400' : 'text-rose-600'}`}>{usageData.deepseek.error}</p>
                          ) : usageData?.deepseek?.is_available !== undefined ? (
                              <div className="space-y-3">
                                  <div className="flex justify-between items-center text-sm">
                                      <span className={theme === 'dark' ? 'text-[#A1A1AA]' : 'text-[#71717A]'}>Total Balance:</span>
                                      <span className={`font-mono font-medium ${theme === 'dark' ? 'text-emerald-400' : 'text-emerald-600'}`}>
                                          {usageData.deepseek.balance_infos?.[0]?.total_balance} {usageData.deepseek.balance_infos?.[0]?.currency}
                                      </span>
                                  </div>
                                  <div className="flex justify-between items-center text-xs">
                                      <span className={theme === 'dark' ? 'text-[#71717A]' : 'text-[#A1A1AA]'}>Account Status:</span>
                                      <span className={usageData.deepseek.is_available ? 'text-emerald-500' : 'text-rose-500'}>
                                          {usageData.deepseek.is_available ? 'Active' : 'Insufficient'}
                                      </span>
                                  </div>
                              </div>
                          ) : (
                              <p className={`text-xs ${theme === 'dark' ? 'text-[#888]' : 'text-[#7A7571]'}`}>No data available.</p>
                          )}
                      </div>

                      <div className={`p-5 rounded-2xl ${theme === 'dark' ? 'bg-black/20 border border-white/5' : 'bg-white/40 border border-black/5'}`}>
                          <div className="flex items-center gap-3 mb-4">
                              <div className="w-3 h-3 rounded-full bg-purple-500 shadow-[0_0_10px_rgba(168,85,247,0.5)]"></div>
                              <h4 className={`text-sm font-bold tracking-wider uppercase ${theme === 'dark' ? 'text-[#E5E5E5]' : 'text-[#333]'}`}>Qwen</h4>
                          </div>
                          <p className={`text-xs leading-relaxed mb-4 ${theme === 'dark' ? 'text-[#A1A1AA]' : 'text-[#71717A]'}`}>
                              {usageData?.qwen?.message || "DashScope does not publicly expose API token balances via the standard endpoint."}
                          </p>
                          <a href={usageData?.qwen?.consoleUrl || "[https://dashscope.console.aliyun.com/billing](https://dashscope.console.aliyun.com/billing)"} target="_blank" rel="noopener noreferrer" className={`inline-flex items-center gap-1.5 text-xs font-semibold transition-colors ${theme === 'dark' ? 'text-indigo-400 hover:text-indigo-300' : 'text-indigo-600 hover:text-indigo-500'}`}>
                              Open DashScope Console
                              <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" /></svg>
                          </a>
                      </div>
                  </div>
              )}
          </div>
        </div>
      )}

      <div className={`flex h-[100dvh] font-sans overflow-hidden transition-colors duration-500 ${theme === 'dark' ? 'bg-[#0A0A0A] text-[#E5E5E5] selection:bg-white/20' : 'bg-[#FAFAFA] text-[#18181B] selection:bg-black/10'}`}>
        
        {chatToDelete && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-xl p-4 animate-in fade-in duration-500 ease-spring">
            <div className={`p-8 rounded-3xl max-w-sm w-full shadow-2xl ${theme === 'dark' ? 'glass-dark-solid' : 'glass-light-solid'}`}>
              <h3 className={`text-lg font-medium mb-4 ${theme === 'dark' ? 'text-[#F4F4F5]' : 'text-[#18181B]'}`}>Delete Conversation</h3>
              <p className={`text-[15px] mb-8 leading-relaxed ${theme === 'dark' ? 'text-[#A1A1AA]' : 'text-[#71717A]'}`}>This action cannot be undone. The conversation will be permanently removed.</p>
              <div className="flex justify-end space-x-4">
                <button onClick={() => setChatToDelete(null)} className={`px-5 py-2.5 rounded-full text-sm font-medium transition-all active:scale-95 ${theme === 'dark' ? 'text-[#A1A1AA] hover:text-white hover:bg-white/10' : 'text-[#71717A] hover:text-black hover:bg-black/5'}`}>Cancel</button>
                <button onClick={confirmDeleteChat} className={`px-5 py-2.5 rounded-full text-sm font-medium transition-all active:scale-95 bg-rose-600 text-white hover:bg-rose-500 shadow-[0_0_15px_rgba(225,29,72,0.3)]`}>Delete</button>
              </div>
            </div>
          </div>
        )}

        <aside ref={sidebarRef} className={`${isSidebarOpen ? 'w-64 md:w-72' : 'w-0'} transition-all duration-500 ease-spring flex-shrink-0 border-r flex flex-col overflow-hidden z-30 absolute md:relative h-full ${theme === 'dark' ? 'bg-[#0A0A0A]/60 backdrop-blur-3xl border-white/5' : 'bg-[#FAFAFA]/70 backdrop-blur-3xl border-black/5'}`}>
          <div className="p-6 pb-4 flex items-center justify-between">
            <h2 className={`text-[10px] tracking-widest uppercase font-semibold ${theme === 'dark' ? 'text-[#71717A]' : 'text-[#A1A1AA]'}`}>Sessions</h2>
            <button onClick={createNewChat} className={`p-2 transition-all duration-300 active:scale-90 rounded-full ${theme === 'dark' ? 'text-[#A1A1AA] hover:text-white hover:bg-white/10' : 'text-[#71717A] hover:text-black hover:bg-black/5'}`} title="New Chat">
              <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
            </button>
          </div>
          
          <div className="px-5 pb-4">
             <div className={`relative flex items-center w-full rounded-2xl transition-all ${theme === 'dark' ? 'bg-white/5 focus-within:bg-white/10' : 'bg-black/5 focus-within:bg-black/10'}`}>
                <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className={`w-3.5 h-3.5 absolute left-4 ${theme === 'dark' ? 'text-[#A1A1AA]' : 'text-[#71717A]'}`}>
                   <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                </svg>
                <input 
                   type="text" 
                   placeholder="Search..." 
                   value={chatSearchQuery}
                   onChange={(e) => setChatSearchQuery(e.target.value)}
                   onKeyDown={(e) => e.key === 'Enter' && executeChatSearch()}
                   className={`w-full bg-transparent text-[13px] py-2.5 pl-10 pr-8 focus:outline-none ${theme === 'dark' ? 'text-[#F4F4F5] placeholder-[#71717A]' : 'text-[#18181B] placeholder-[#A1A1AA]'}`}
                />
                {isSearchingChats && (
                   <div className="absolute right-4">
                      <svg className="animate-spin h-3 w-3 text-indigo-500" xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                   </div>
                )}
                {!isSearchingChats && chatSearchQuery && (
                   <button onClick={() => { setChatSearchQuery(""); setSearchResults(null); }} className={`absolute right-4 transition-opacity ${theme === 'dark' ? 'text-[#71717A] hover:text-white' : 'text-[#A1A1AA] hover:text-black'}`}>
                      <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                   </button>
                )}
             </div>
          </div>

          <div className="flex-1 overflow-y-auto px-3 space-y-1 pb-4 custom-scrollbar">
            {displayChats.map(chat => (
              <div key={chat.id} className={`group relative flex items-center w-full rounded-xl transition-all duration-300 ease-spring ${activeChatId === chat.id ? (theme === 'dark' ? 'bg-white/10 text-white' : 'bg-black/5 text-black') : (theme === 'dark' ? 'text-[#A1A1AA] hover:bg-white/5 hover:text-white' : 'text-[#71717A] hover:bg-black/5 hover:text-black')}`}>
                {editingChatId === chat.id ? (
                  <form onSubmit={(e) => saveEditedTitle(chat.id, e)} className="flex-1 flex items-center px-4 py-3">
                    <input autoFocus type="text" value={editTitleInput} onChange={(e) => setEditTitleInput(e.target.value)} onBlur={(e) => saveEditedTitle(chat.id, e)} className={`w-full bg-transparent border-b text-[13px] outline-none pb-1 ${theme === 'dark' ? 'border-white/20 text-white' : 'border-black/20 text-black'}`} />
                  </form>
                ) : (
                  <button onClick={() => selectChat(chat.id)} className="flex-1 text-left px-4 py-3.5 text-[13px] flex items-center space-x-3 overflow-hidden">
                    {chat.isAgentSession && <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 shadow-[0_0_5px_rgba(99,102,241,0.5)] shrink-0" title="Swarm Session"></span>}
                    <div className="flex-1 overflow-hidden marquee-mask pr-8">
                       <span className="marquee-inner">{chat.title}</span>
                    </div>
                  </button>
                )}
                
                {!editingChatId && (
                  <div className={`absolute right-2 flex items-center z-10 transition-opacity duration-300 session-menu-container ${activeSessionMenuId === chat.id ? 'opacity-100' : 'opacity-0 md:group-hover:opacity-100'}`}>
                    <button onClick={(e) => { e.stopPropagation(); setActiveSessionMenuId(activeSessionMenuId === chat.id ? null : chat.id); }} className={`p-1.5 rounded-full transition-colors ${activeSessionMenuId === chat.id ? (theme === 'dark' ? 'bg-white/20 text-white' : 'bg-black/10 text-black') : (theme === 'dark' ? 'text-[#71717A] hover:text-white hover:bg-white/10' : 'text-[#A1A1AA] hover:text-black hover:bg-black/5')}`}>
                      <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 12.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 18.75a.75.75 0 110-1.5.75.75 0 010 1.5z" /></svg>
                    </button>
                    
                    {activeSessionMenuId === chat.id && (
                      <div className={`absolute top-full right-0 mt-2 w-36 rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-300 ease-spring ${theme === 'dark' ? 'glass-dark-solid' : 'glass-light-solid'}`}>
                         <button onClick={(e) => startEditingTitle(chat.id, chat.title, e)} className={`w-full text-left px-4 py-2.5 text-[13px] flex items-center gap-2 transition-colors ${theme === 'dark' ? 'text-white hover:bg-white/10' : 'text-black hover:bg-black/5'}`}>
                            <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487zm0 0L19.5 7.125" /></svg>
                            Rename
                         </button>
                         <div className={`h-px w-full ${theme === 'dark' ? 'bg-white/10' : 'bg-black/10'}`} />
                         <button onClick={(e) => { e.stopPropagation(); setChatToDelete(chat.id); }} className={`w-full text-left px-4 py-2.5 text-[13px] flex items-center gap-2 transition-colors ${theme === 'dark' ? 'text-rose-400 hover:bg-rose-500/20' : 'text-rose-600 hover:bg-rose-500/10'}`}>
                            <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
                            Delete
                         </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className={`p-5 relative ${theme === 'dark' ? 'border-t border-white/5' : 'border-t border-black/5'}`} ref={settingsDropdownRef}>
            <button onClick={() => setIsSettingsOpen(!isSettingsOpen)} className={`w-full flex items-center space-x-3 px-4 py-3 rounded-2xl text-[13px] transition-all duration-300 ease-spring tracking-wide ${theme === 'dark' ? 'text-[#A1A1AA] hover:text-white hover:bg-white/5' : 'text-[#71717A] hover:text-black hover:bg-black/5'}`}>
              <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.43l-1.003.767c-.29.222-.434.59-.383.951.005.034.008.068.008.102 0 .034-.003.068-.008.102-.051.362.093.73.383.951l1.003.767a1.125 1.125 0 01.26 1.43l-1.296 2.247a1.125 1.125 0 01-1.37.49l-1.216-.456c-.356-.133-.751-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.37-.49l-1.296-2.247a1.125 1.125 0 01.26-1.43l1.002-.767c.29-.222.434-.59.384-.951a1.747 1.747 0 01-.008-.204c.05-.361-.093-.73-.384-.951l-1.002-.767a1.125 1.125 0 01-.26-1.43l1.296-2.247a1.125 1.125 0 011.37-.49l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.28z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
              <span>Preferences</span>
            </button>

            {isSettingsOpen && (
              <div className={`absolute bottom-full left-5 mb-3 w-52 rounded-2xl shadow-2xl z-50 overflow-hidden py-1.5 animate-in fade-in slide-in-from-bottom-4 duration-500 ease-spring ${theme === 'dark' ? 'glass-dark-solid' : 'glass-light-solid'}`}>
                <div className={`px-5 py-2.5 border-b ${theme === 'dark' ? 'border-white/10' : 'border-black/10'}`}><h3 className={`text-[9px] font-semibold uppercase tracking-widest ${theme === 'dark' ? 'text-[#71717A]' : 'text-[#A1A1AA]'}`}>Theme</h3></div>
                <button type="button" onClick={() => { setTheme('light'); localStorage.setItem('c_ai_theme', 'light'); setIsSettingsOpen(false); }} className={`w-full text-left px-5 py-3 text-[13px] tracking-wide flex items-center justify-between ${theme === 'light' ? 'text-black bg-black/5' : (theme === 'dark' ? 'text-[#A1A1AA] hover:text-white hover:bg-white/10' : 'text-[#71717A] hover:text-black hover:bg-black/5')} transition-colors`}><span>Minimal Light</span></button>
                <button type="button" onClick={() => { setTheme('dark'); localStorage.setItem('c_ai_theme', 'dark'); setIsSettingsOpen(false); }} className={`w-full text-left px-5 py-3 text-[13px] tracking-wide flex items-center justify-between ${theme === 'dark' ? 'text-white bg-white/10' : 'text-[#71717A] hover:text-black hover:bg-black/5'} transition-colors`}><span>Liquid Dark</span></button>
                
                <div className={`h-px w-full my-1.5 ${theme === 'dark' ? 'bg-white/10' : 'bg-black/10'}`} />
                <button type="button" onClick={() => { setIsSettingsOpen(false); setIsUsageModalOpen(true); fetchUsage(); }} className={`w-full text-left px-5 py-3 text-[13px] tracking-wide flex items-center justify-between transition-colors ${theme === 'dark' ? 'text-[#A1A1AA] hover:text-white hover:bg-white/10' : 'text-[#71717A] hover:text-black hover:bg-black/5'}`}>
                  <span className="flex items-center gap-2">
                      <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                      API Limits
                  </span>
                </button>
              </div>
            )}
          </div>
        </aside>

        <main onDragEnter={handleDragEnter} onDragLeave={handleDragLeave} onDragOver={handleDragOver} onDrop={handleDrop} className={`flex-1 flex flex-col h-full relative min-w-0 transition-colors duration-500 overflow-hidden`}>
          {isDragging && (
            <div className={`absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xl border-2 border-dashed ${theme === 'dark' ? 'border-indigo-500/50' : 'border-indigo-400/50'}`}>
              <div className="flex flex-col items-center space-y-6 animate-in fade-in zoom-in duration-500 ease-spring">
                <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-16 h-16 text-indigo-400 animate-bounce"><path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" /></svg>
                <h2 className="text-3xl font-light text-white tracking-wide">Drop files to attach</h2>
              </div>
            </div>
          )}
          
          <div className="absolute inset-0 pointer-events-none overflow-hidden z-0 select-none">
            <div className={`absolute -top-[35%] -left-[15%] w-[75%] h-[75%] rounded-full blur-[140px] animate-aurora-1 transition-colors duration-1000 ${theme === 'dark' ? 'bg-indigo-900/10' : 'bg-indigo-300/20'}`} />
            <div className={`absolute -bottom-[35%] -right-[15%] w-[75%] h-[75%] rounded-full blur-[140px] animate-aurora-2 transition-colors duration-1000 ${theme === 'dark' ? 'bg-teal-900/10' : 'bg-teal-300/20'}`} />
          </div>

          <header className={`h-16 flex items-center px-6 z-20 sticky top-0 flex-shrink-0 transition-colors ${theme === 'dark' ? 'bg-[#0A0A0A]/40 backdrop-blur-2xl border-b border-white/5' : 'bg-[#FAFAFA]/50 backdrop-blur-2xl border-b border-black/5'}`}>
            <button id="sidebar-toggle" onClick={(e) => { e.stopPropagation(); setIsSidebarOpen(!isSidebarOpen); }} className={`p-2 mr-4 rounded-full transition-all active:scale-90 relative z-20 ${theme === 'dark' ? 'hover:bg-white/10 text-[#A1A1AA]' : 'hover:bg-black/5 text-[#71717A]'}`}>
              <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12" /></svg>
            </button>

            {/* UPGRADED HEADER: MODEL AND MODE INDICATOR REMOVED */}
            <div className={`flex items-center space-x-3 ${theme === 'dark' ? 'text-white' : 'text-black'}`}>
              <h1 className="text-lg font-bold tracking-widest uppercase">C-Ai</h1>
            </div>
            
            <div className="ml-auto flex items-center space-x-4">
              <button onClick={(e) => { e.stopPropagation(); setIsFilesPanelOpen(true); }} className={`flex items-center space-x-2 transition-all active:scale-95 focus:outline-none ${theme === 'dark' ? 'text-[#A1A1AA] hover:text-white' : 'text-[#71717A] hover:text-black'}`} title="Open session workspace">
                <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" /></svg>
                <span className="text-[11px] tracking-widest font-mono font-medium">{filesInChat.length}</span>
              </button>
            </div>
          </header>

          {pinnedContexts.length > 0 && (
            <div className={`flex items-center gap-3 px-6 py-3 z-10 sticky top-16 backdrop-blur-2xl border-b overflow-x-auto custom-scrollbar shadow-sm ${theme === 'dark' ? 'bg-[#0A0A0A]/40 border-white/5' : 'bg-[#FAFAFA]/50 border-black/5'}`}>
               <div className={`text-[10px] uppercase tracking-widest font-bold mr-2 flex items-center gap-1.5 shrink-0 ${theme === 'dark' ? 'text-indigo-400' : 'text-indigo-600'}`}>
                 {getPinIcon()} 
                 <span>Pinned Context</span>
               </div>
               {pinnedContexts.map(pin => (
                  <div key={pin.id} className={`flex items-center space-x-3 px-4 py-1.5 rounded-full border text-[12px] whitespace-nowrap group shrink-0 transition-all ${theme === 'dark' ? 'bg-black/40 border-white/10 text-[#D4D4D8]' : 'bg-white/40 border-black/10 text-[#3F3F46]'}`}>
                     <span className="max-w-[150px] md:max-w-[350px] truncate">{pin.text}</span>
                     <button type="button" onClick={() => removePin(pin.id)} className={`opacity-0 group-hover:opacity-100 transition-opacity ${theme === 'dark' ? 'hover:text-rose-400' : 'hover:text-rose-500'}`}>
                        <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" /></svg>
                     </button>
                  </div>
               ))}
            </div>
          )}

          <div ref={chatContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 md:px-10 relative z-0 flex flex-col">
            {messages.length === 0 ? (
              <div className="flex-1 flex items-center justify-center flex-col space-y-8">
                <div className="relative flex flex-col items-center justify-center min-h-[300px]">
                  <div className={`absolute top-0 transition-all duration-1000 ease-spring ${showOrb ? 'opacity-100 scale-100' : 'opacity-0 scale-90 pointer-events-none'}`}>
                    <div className="relative w-24 h-24">
                      <div className={`absolute inset-0 bg-gradient-to-tr ${isAgentMode ? 'from-indigo-600/50 to-pink-600/50' : (theme === 'dark' ? 'from-blue-600/20 to-purple-600/20' : 'from-blue-400/30 to-purple-400/30')} animate-fluid blur-md`}></div>
                      <div className={`absolute inset-0 bg-gradient-to-bl ${theme === 'dark' ? 'from-teal-500/20 to-transparent' : 'from-teal-400/30 to-transparent'} animate-fluid delay-150 blur-lg`}></div>
                      <div className={`absolute inset-3 bg-gradient-to-r ${theme === 'dark' ? 'from-white/10 to-transparent' : 'from-white/40 to-transparent'} animate-fluid delay-300 blur-sm`}></div>
                    </div>
                  </div>
                  <div className={`transition-all duration-1000 mt-[140px] text-center`}>
                    <h2 className={`text-2xl md:text-3xl font-light tracking-tight ${theme === 'dark' ? 'text-white' : 'text-[#18181B]'} h-10 flex items-center justify-center`}>
                      {isAgentMode ? "Swarm ready. Describe the objective." : typedText}
                      {!isAgentMode && <span className={`inline-block w-0.5 h-7 ml-1.5 bg-current transition-opacity duration-300 ${showOrb ? 'animate-pulse' : 'opacity-0'}`}></span>}
                    </h2>
                    <p className={`text-[15px] mt-4 transition-opacity duration-1000 font-light tracking-wide ${!showOrb && !isAgentMode ? 'opacity-100' : 'opacity-0'} ${theme === 'dark' ? 'text-[#A1A1AA]' : 'text-[#71717A]'}`}>
                      {isAgentMode ? "Agents automatically execute upon approval." : "Enter a prompt to begin."}
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="max-w-4xl lg:max-w-5xl mx-auto w-full pt-10 pb-12 space-y-12">
                {messages.map((msg, idx) => {
                  if (msg.role === 'info') {
                    return (
                      <div key={idx} id={`message-${idx}`} className="flex justify-center my-6 opacity-80 animate-in fade-in zoom-in duration-500">
                          <div className={`px-4 py-1.5 rounded-full text-[11px] font-mono tracking-widest uppercase flex items-center gap-3 shadow-sm border backdrop-blur-md ${theme === 'dark' ? 'bg-white/5 border-white/10 text-[#A1A1AA]' : 'bg-black/5 border-black/10 text-[#71717A]'}`}>
                              <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>
                              <span>{msg.content}</span>
                          </div>
                      </div>
                    );
                  }

                  const isUser = msg.role === "user";
                  const swarmData = !isUser ? parseSwarmMessage(msg.content) : null;
                  const parsedData = isUser || !swarmData ? parseMessageData(msg.content) : { text: "", files: [] };
                  
                  const finalFiles = swarmData ? parseMessageData(swarmData.queenText).files : parsedData.files;
                  const textToPin = swarmData ? parseMessageData(swarmData.queenText).text : parsedData.text;

                  return (
                    <div id={`message-${idx}`} key={idx} className={`flex group relative w-full ${isUser ? "justify-end" : "justify-start"}`}>
                      
                      {isUser && (
                        <div className="hidden sm:flex flex-col justify-end mr-4 pb-2 opacity-0 group-hover:opacity-100 transition-opacity duration-300 gap-1">
                          <button onClick={() => copyMessageToClipboard(parsedData.text, idx)} className={`p-2 rounded-full ${theme === 'dark' ? 'text-[#A1A1AA] hover:bg-white/10 hover:text-white' : 'text-[#71717A] hover:bg-black/5 hover:text-black'}`} title="Copy message">
                            {getCopyIcon()}
                          </button>
                          <button onClick={() => handlePinMessage(textToPin)} className={`p-2 rounded-full ${theme === 'dark' ? 'text-[#A1A1AA] hover:bg-white/10 hover:text-indigo-400' : 'text-[#71717A] hover:bg-black/5 hover:text-indigo-600'}`} title="Pin context">
                            {getPinIcon()}
                          </button>
                        </div>
                      )}

                      <div className={`relative max-w-[85%] md:max-w-[75%] ${swarmData ? 'w-full max-w-full' : ''} px-8 py-6 text-[15px] leading-relaxed font-light rounded-3xl ${isUser ? (theme === 'dark' ? 'glass-dark text-[#F4F4F5] rounded-tr-sm' : 'glass-light text-[#18181B] rounded-tr-sm') : (theme === 'dark' ? 'bg-transparent text-[#E4E4E7]' : 'bg-transparent text-[#27272A]')}`}>
                        {isUser ? (
                          <div>
                            <div className="whitespace-pre-wrap break-words">{parsedData.text}</div>
                            {parsedData.files.length > 0 && (
                              <div className={`flex flex-wrap gap-2 mt-5 pt-5 border-t ${theme === 'dark' ? 'border-white/10' : 'border-black/10'}`}>
                                {parsedData.files.map((file, fIdx) => (
                                  <button type="button" onClick={() => downloadFile(file.name, file.content)} key={fIdx} className={`flex items-center space-x-2 px-3 py-1.5 rounded-lg text-xs border cursor-pointer hover:opacity-80 transition-opacity ${theme === 'dark' ? 'bg-black/40 border-white/5 text-[#A1A1AA]' : 'bg-white/60 border-black/5 text-[#71717A]'}`} title="Click to download file">
                                    <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg>
                                    <span className="truncate max-w-[200px]">{file.name}</span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        ) : swarmData ? (
                          <div className="w-full">
                             {/* THE PROPOSED PLAN HITL UI */}
                             {swarmData.proposedPlan && (
                                 <div className={`mb-10 p-8 rounded-3xl shadow-2xl ${theme === 'dark' ? 'glass-dark border-indigo-500/20' : 'glass-light border-indigo-400/20'}`}>
                                     <div className="flex items-center justify-between mb-8 border-b pb-6 border-dashed border-indigo-500/30">
                                         <div>
                                            <h3 className={`text-xs uppercase tracking-widest font-bold flex items-center gap-2 ${theme === 'dark' ? 'text-indigo-400' : 'text-indigo-600'}`}>
                                                <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5"><path fillRule="evenodd" d="M3 6a3 3 0 013-3h12a3 3 0 013 3v12a3 3 0 01-3 3H6a3 3 0 01-3-3V6zm4.5 7.5a.75.75 0 01.75.75v2.25a.75.75 0 01-1.5 0v-2.25a.75.75 0 01.75-.75zm3.75-1.5a.75.75 0 00-1.5 0v4.5a.75.75 0 001.5 0V12zm2.25-3a.75.75 0 011.5 0v7.5a.75.75 0 01-1.5 0V9z" clipRule="evenodd" /></svg>
                                                Manager's Proposed Plan
                                            </h3>
                                            <p className={`text-[13px] mt-2 mb-0 ${theme === 'dark' ? 'text-[#A1A1AA]' : 'text-[#71717A]'}`}>Awaiting Project Lead Approval to commence Swarm</p>
                                         </div>
                                     </div>

                                     <div className="space-y-4 mb-8">
                                         {swarmData.proposedPlan.map((agent, pIdx) => (
                                             <div key={agent.id} className={`p-5 rounded-2xl flex items-start gap-5 ${theme === 'dark' ? 'bg-black/20 border border-white/5' : 'bg-white/40 border border-black/5'}`}>
                                                 <div className={`mt-0.5 flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center font-mono text-[11px] font-bold ${agent.role.includes('QA') ? 'bg-emerald-500/10 text-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.2)]' : 'bg-indigo-500/10 text-indigo-500 shadow-[0_0_10px_rgba(99,102,241,0.2)]'}`}>
                                                     {pIdx + 1}
                                                 </div>
                                                 <div>
                                                     <h4 className={`text-[15px] font-medium mb-1.5 ${theme === 'dark' ? 'text-white' : 'text-black'}`}>{agent.role}</h4>
                                                     <p className={`text-[13px] leading-relaxed ${theme === 'dark' ? 'text-[#A1A1AA]' : 'text-[#71717A]'}`}>{agent.description}</p>
                                                 </div>
                                             </div>
                                         ))}
                                     </div>

                                     {idx === messages.length - 1 && activeProposedPlan && (
                                         <div className="flex flex-col sm:flex-row items-center gap-4">
                                            <button onClick={executeApprovedPlan} className="w-full sm:w-auto px-8 py-3.5 rounded-full bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-bold uppercase tracking-widest transition-all duration-300 ease-spring active:scale-95 shadow-[0_0_20px_rgba(79,70,229,0.3)] flex items-center justify-center gap-2">
                                                <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" /></svg>
                                                Approve & Execute
                                            </button>
                                            <p className={`text-[13px] ${theme === 'dark' ? 'text-[#71717A]' : 'text-[#A1A1AA]'}`}>Or type modifications below to request a new plan.</p>
                                         </div>
                                     )}
                                 </div>
                             )}

                             {swarmData.plan.length > 0 && (
                                <div className={`mb-10 p-6 rounded-3xl shadow-xl ${theme === 'dark' ? 'glass-dark' : 'glass-light'}`}>
                                   <h3 className={`text-[11px] uppercase tracking-widest font-semibold mb-6 flex items-center gap-2 ${theme === 'dark' ? 'text-indigo-400' : 'text-indigo-600'}`}>
                                      <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M14.615 1.595a.75.75 0 01.359.852L12.982 9.75h7.268a.75.75 0 01.548 1.262l-10.5 11.25a.75.75 0 01-1.272-.71l1.992-7.302H3.75a.75.75 0 01-.548-1.262l10.5-11.25a.75.75 0 01.913-.143z" clipRule="evenodd" /></svg>
                                      Swarm Execution {idx === messages.length -1 && isStreaming && <span className="flex items-center gap-1.5 ml-3 opacity-60"><span className="w-1.5 h-1.5 rounded-full bg-current animate-ping"></span>Live</span>}
                                   </h3>
                                   
                                   <div className="flex items-center overflow-x-auto pb-6 pt-2 px-2 custom-scrollbar gap-2 relative">
                                      {swarmData.plan.map((agent, aIdx) => {
                                         const status = swarmData.agents[agent.id]?.status || 'waiting';
                                         const isNodeActive = status === 'thinking' || status === 'reviewing' || status === 'revising';
                                         
                                         return (
                                            <React.Fragment key={agent.id}>
                                              <button onClick={() => setViewingAgent({ msgIndex: idx, agentId: agent.id })} className={`relative flex-shrink-0 w-40 p-4 rounded-2xl transition-all duration-500 ease-spring active:scale-95 ${
                                                 isNodeActive ? (theme === 'dark' ? 'border border-indigo-500/50 bg-indigo-500/10 shadow-[0_0_20px_rgba(99,102,241,0.15)] scale-[1.02]' : 'border border-indigo-400 bg-indigo-50 shadow-md scale-[1.02]') :
                                                 status === 'completed' ? (theme === 'dark' ? 'border border-white/5 bg-black/40' : 'border border-black/5 bg-white/40') :
                                                 (theme === 'dark' ? 'border border-white/5 opacity-40 hover:opacity-80' : 'border border-black/5 opacity-50 hover:opacity-80')
                                              }`}>
                                                 <div className="flex flex-col items-center justify-center text-center">
                                                    <div className="mb-3">
                                                        {status === 'thinking' && <svg className="animate-spin h-5 w-5 text-indigo-500 drop-shadow-[0_0_8px_rgba(99,102,241,0.5)]" xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>}
                                                        {status === 'reviewing' && <div className="h-5 w-5 rounded-full border-2 border-orange-500 border-t-transparent animate-spin drop-shadow-[0_0_8px_rgba(249,115,22,0.5)]"></div>}
                                                        {status === 'revising' && <svg className="animate-spin h-5 w-5 text-rose-500 drop-shadow-[0_0_8px_rgba(244,63,94,0.5)]" xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>}
                                                        {status === 'completed' && <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5 text-emerald-500 drop-shadow-[0_0_8px_rgba(16,185,129,0.5)]"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" /></svg>}
                                                        {status === 'waiting' && <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
                                                    </div>
                                                    <span className={`text-[13px] font-medium w-full truncate ${theme === 'dark' ? 'text-[#F4F4F5]' : 'text-[#18181B]'}`}>{agent.role}</span>
                                                    <span className={`text-[9px] uppercase tracking-widest mt-2 ${
                                                      isNodeActive ? 'text-indigo-500 font-bold' :
                                                      (theme === 'dark' ? 'text-[#71717A]' : 'text-[#A1A1AA]')
                                                    }`}>{status}</span>
                                                 </div>
                                              </button>
                                              
                                              {aIdx < swarmData.plan.length - 1 && (
                                                <div className="flex-shrink-0 flex items-center w-6 md:w-12">
                                                   <div className={`h-[2px] w-full rounded-full transition-colors duration-500 ${
                                                      status === 'completed' ? 'bg-emerald-500/50' : 
                                                      isNodeActive ? 'bg-indigo-500 animate-pulse shadow-[0_0_8px_rgba(99,102,241,0.5)]' : 
                                                      (theme === 'dark' ? 'bg-white/10' : 'bg-black/10')
                                                   }`}></div>
                                                </div>
                                              )}
                                            </React.Fragment>
                                         )
                                      })}
                                   </div>
                                </div>
                             )}

                             {swarmData.queenText && (
                                <div className={`prose max-w-none prose-p:leading-relaxed prose-pre:bg-transparent prose-pre:p-0 prose-pre:my-6 prose-a:underline prose-a:underline-offset-4 ${theme === 'dark' ? 'prose-invert prose-a:text-[#F4F4F5] hover:prose-a:text-white prose-p:text-[#D4D4D8]' : 'prose-a:text-[#18181B] hover:prose-a:text-black prose-p:text-[#3F3F46]'}`}>
                                   <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
                                      {parseMessageData(swarmData.queenText).text}
                                   </ReactMarkdown>
                                   
                                   {finalFiles.length > 0 && (
                                     <div className={`my-10 p-6 rounded-3xl shadow-xl ${theme === 'dark' ? 'glass-dark border-white/5' : 'glass-light border-black/5'}`}>
                                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-5 mb-5">
                                          <div>
                                            <h4 className={`text-[15px] font-medium m-0 flex items-center gap-3 ${theme === 'dark' ? 'text-[#F4F4F5]' : 'text-[#18181B]'}`}>
                                              <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 text-indigo-500"><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 14.15v4.25c0 1.08-.88 1.95-1.95 1.95H5.7c-1.08 0-1.95-.88-1.95-1.95v-4.25m16.5 0a2.18 2.18 0 00-1.51-.58H7.21c-.58 0-1.12.23-1.51.58m16.5 0v-2.35c0-1.08-.88-1.95-1.95-1.95H5.7c-1.08 0-1.95.88-1.95 1.95v2.35m16.5 0H3.75m10.5-8.25L12 3m0 0L7.5 8.25M12 3v11.25" /></svg>
                                              Project Package
                                            </h4>
                                            <p className={`text-[13px] mt-1.5 mb-0 ${theme === 'dark' ? 'text-[#A1A1AA]' : 'text-[#71717A]'}`}>Compiled structure with {finalFiles.length} files.</p>
                                          </div>
                                          <button 
                                            onClick={() => downloadProjectZip(finalFiles, "Swarm_Project")}
                                            className="flex items-center justify-center gap-2 px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-bold uppercase tracking-widest rounded-full transition-all duration-300 active:scale-95 shadow-[0_0_15px_rgba(79,70,229,0.3)]"
                                          >
                                            Download (ZIP)
                                          </button>
                                        </div>
                                        
                                        <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-5 pt-5 border-t ${theme === 'dark' ? 'border-white/10' : 'border-black/10'}`}>
                                          {finalFiles.map((file, fIdx) => (
                                            <button type="button" onClick={() => downloadFile(file.name, file.content)} key={fIdx} className={`flex items-center space-x-3 px-4 py-2.5 rounded-xl text-[13px] border cursor-pointer hover:opacity-80 transition-all active:scale-95 text-left ${theme === 'dark' ? 'bg-black/20 border-white/5 text-[#A1A1AA]' : 'bg-white/40 border-black/5 text-[#71717A]'}`} title="Click to download file">
                                              <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 shrink-0"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg>
                                              <span className="truncate">{file.name}</span>
                                            </button>
                                          ))}
                                        </div>
                                     </div>
                                   )}
                                </div>
                             )}
                          </div>
                        ) : (
                          <div className={`prose max-w-none prose-p:leading-relaxed prose-pre:bg-transparent prose-pre:p-0 prose-pre:my-8 prose-a:underline prose-a:underline-offset-4 ${theme === 'dark' ? 'prose-invert prose-a:text-[#F4F4F5] hover:prose-a:text-white prose-p:text-[#D4D4D8]' : 'prose-a:text-[#18181B] hover:prose-a:text-black prose-p:text-[#3F3F46]'}`}>
                            <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
                              {parsedData.text}
                            </ReactMarkdown>
                          </div>
                        )}
                      </div>

                      {!isUser && (
                        <div className="hidden sm:flex flex-col justify-end ml-4 pb-2 opacity-0 group-hover:opacity-100 transition-opacity duration-300 gap-1">
                          <button onClick={() => copyMessageToClipboard(textToPin, idx)} className={`p-2 rounded-full ${theme === 'dark' ? 'text-[#A1A1AA] hover:bg-white/10 hover:text-white' : 'text-[#71717A] hover:bg-black/5 hover:text-black'}`} title="Copy message">
                            {getCopyIcon()}
                          </button>
                          <button onClick={() => handlePinMessage(textToPin)} className={`p-2 rounded-full ${theme === 'dark' ? 'text-[#A1A1AA] hover:bg-white/10 hover:text-indigo-400' : 'text-[#71717A] hover:bg-black/5 hover:text-indigo-600'}`} title="Pin context">
                            {getPinIcon()}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
                
                {isLoading && !isStreaming && (
                  <div className="flex justify-start">
                    <div className="py-4 flex space-x-2 items-center opacity-50 pl-2">
                      <div className={`w-2 h-2 rounded-full animate-pulse ${theme === 'dark' ? 'bg-[#A1A1AA]' : 'bg-[#71717A]'}`}></div>
                      <div className={`w-2 h-2 rounded-full animate-pulse delay-150 ${theme === 'dark' ? 'bg-[#A1A1AA]' : 'bg-[#71717A]'}`}></div>
                      <div className={`w-2 h-2 rounded-full animate-pulse delay-300 ${theme === 'dark' ? 'bg-[#A1A1AA]' : 'bg-[#71717A]'}`}></div>
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} className="h-8" />
              </div>
            )}
          </div>

          <div className={`px-4 md:px-10 pb-8 flex-shrink-0 relative z-10 bg-transparent`}>
            
            {/* FLOATING FAB for Jumping to Bottom */}
            {isAutoScrollPaused && messages.length > 0 && (
                <div className="absolute bottom-28 left-1/2 transform -translate-x-1/2 z-[100] animate-in fade-in slide-in-from-bottom-4 duration-300">
                    <button
                        onClick={scrollToBottom}
                        className={`flex items-center gap-2 px-5 py-2.5 rounded-full shadow-[0_4px_20px_rgba(0,0,0,0.15)] border text-[11px] font-bold uppercase tracking-widest transition-all active:scale-95 ${theme === 'dark' ? 'bg-[#1A1A1A]/90 backdrop-blur-xl border-white/10 text-[#E5E5E5] hover:bg-[#222]/90 hover:text-white' : 'bg-white/90 backdrop-blur-xl border-black/10 text-[#18181B] hover:bg-gray-50'}`}
                    >
                        <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 13.5L12 21m0 0l-7.5-7.5M12 21V3" /></svg>
                        Jump to Latest
                    </button>
                </div>
            )}

            {isAutoLooping && (
               <div className="fixed bottom-32 right-10 z-50 animate-in fade-in slide-in-from-bottom-5 duration-500 ease-spring">
                  <button onClick={forceStopAutoRun} className="flex items-center space-x-3 bg-rose-600 hover:bg-rose-500 text-white px-6 py-3 rounded-full shadow-[0_0_30px_rgba(225,29,72,0.4)] backdrop-blur-md border border-rose-500/50 transition-all active:scale-95">
                      <span className="w-2.5 h-2.5 rounded-full bg-white animate-pulse" />
                      <span className="text-[11px] font-bold tracking-widest uppercase">Force Stop Execution Loop</span>
                  </button>
               </div>
            )}
            
            <div className="max-w-4xl lg:max-w-5xl mx-auto relative">
              
              {/* EXECUTE LATEST SCRIPT FLOATING BUTTON */}
              {lastPythonCode && !isAutoLooping && !isLoading && (
                 <div className="absolute -top-12 right-2 z-10 animate-in fade-in slide-in-from-bottom-3 duration-500">
                    <button
                       onClick={() => runGlobalPython(lastPythonCode)}
                       disabled={isGlobalRunning}
                       className={`flex items-center gap-2 px-5 py-2.5 rounded-full text-[11px] font-bold uppercase tracking-widest shadow-lg backdrop-blur-xl border transition-all active:scale-95 ${
                          theme === 'dark' 
                          ? 'bg-[#1A1A1A]/90 border-white/10 text-emerald-400 hover:bg-[#222]/90 hover:border-emerald-500/50 hover:shadow-[0_0_15px_rgba(52,211,153,0.2)]'
                          : 'bg-white/90 border-black/10 text-emerald-600 hover:bg-gray-50 hover:border-emerald-500/50 hover:shadow-[0_0_15px_rgba(52,211,153,0.2)]'
                       }`}
                    >
                       {isGlobalRunning ? (
                           <svg className="animate-spin h-3.5 w-3.5 text-current" xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                       ) : (
                           <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" /></svg>
                       )}
                       <span>{isGlobalRunning ? 'Executing...' : 'Run Latest Script'}</span>
                    </button>
                 </div>
              )}

              <form onSubmit={sendMessage} className={`relative flex flex-col p-2 transition-all duration-500 ease-spring rounded-[2rem] shadow-2xl ${isAgentMode ? 'shadow-[0_0_30px_rgba(99,102,241,0.15)] ring-1 ring-indigo-500/30' : ''} ${theme === 'dark' ? 'glass-dark focus-within:ring-1 focus-within:ring-white/20' : 'glass-light focus-within:ring-1 focus-within:ring-black/10'}`}>
                
                {attachments.length > 0 && (
                  <div className={`flex flex-wrap gap-3 px-6 py-4 border-b ${theme === 'dark' ? 'border-white/10' : 'border-black/10'}`}>
                    {attachments.map((file, i) => {
                      const isImage = file.type.startsWith('image/');
                      return (
                        <div key={i} className={`relative flex items-center space-x-3 px-4 py-2 rounded-2xl text-[13px] border group ${theme === 'dark' ? 'bg-black/40 text-[#E5E5E5] border-white/10' : 'bg-white/60 text-[#18181B] border-black/10'}`}>
                          {isImage ? (
                            <div className="w-8 h-8 rounded-lg shrink-0 overflow-hidden bg-black/20"><img src={URL.createObjectURL(file)} alt="preview" className="w-full h-full object-cover" /></div>
                          ) : (
                            <div className={`w-8 h-8 flex items-center justify-center rounded-lg shrink-0 ${theme === 'dark' ? 'bg-white/10' : 'bg-black/5'}`}><svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 opacity-70"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg></div>
                          )}
                          <span className="truncate max-w-[120px] font-medium">{file.name}</span>
                          <button type="button" onClick={() => removeAttachment(i)} className={`p-1 rounded-full opacity-60 hover:opacity-100 transition-colors ${theme === 'dark' ? 'hover:bg-white/20 hover:text-white' : 'hover:bg-black/10 hover:text-black'}`}><svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" /></svg></button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* WRAPPING FLEX LAYOUT */}
                <div className="flex flex-row flex-wrap items-end gap-x-2 gap-y-2 p-1 relative w-full">
                  
                  {/* Settings Toggle */}
                  <div className={`relative flex-shrink-0 transition-all ${isInputExpanded ? 'order-2' : 'order-1'}`} ref={modelDropdownRef}>
                    <button type="button" onClick={() => setIsModelDropdownOpen(!isModelDropdownOpen)} className={`h-12 w-12 flex items-center justify-center transition-all duration-300 ease-spring rounded-[1.25rem] opacity-50 hover:opacity-100 ${isModelDropdownOpen ? 'opacity-100 bg-white/10' : ''} ${theme === 'dark' ? 'text-[#F4F4F5]' : 'text-[#18181B]'}`} title="Model & Swarm Settings">
                        <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M10.343 3.94c.09-.542.56-.94 1.11-.94h1.093c.55 0 1.02.398 1.11.94l.149.894c.07.424.384.764.78.93.398.164.855.142 1.205-.108l.737-.527a1.125 1.125 0 011.45.12l.773.774c.39.389.44 1.002.12 1.45l-.527.737c-.25.35-.272.806-.107 1.204.165.397.505.71.93.78l.893.15c.543.09.94.56.94 1.109v1.094c0 .55-.397 1.02-.94 1.11l-.893.149c-.425.07-.765.383-.93.78-.165.398-.143.854.107 1.204l.527.738c.32.447.269 1.06-.12 1.45l-.774.773a1.125 1.125 0 01-1.449.12l-.738-.527c-.35-.25-.807-.272-1.203-.107-.397.165-.71.505-.781.929l-.149.894c-.09.542-.56.94-1.11.94h-1.094c-.55 0-1.019-.398-1.11-.94l-.148-.894c-.071-.424-.384-.764-.781-.93-.398-.164-.854-.142-1.204.108l-.738.527c-.447.32-1.06.269-1.45-.12l-.773-.774a1.125 1.125 0 01-.12-1.45l.527-.737c.25-.35.273-.806.108-1.204-.165-.397-.505-.71-.93-.78l-.894-.15c-.542-.09-.94-.56-.94-1.109v-1.094c0-.55.398-1.02.94-1.11l.894-.149c.424-.07.765-.383.93-.78.165-.398.143-.854-.107-1.204l-.527-.738a1.125 1.125 0 01.12-1.45l.773-.773a1.125 1.125 0 011.45-.12l.737.527c.35.25.807.272 1.204.107.397-.165.71-.505.78-.929l.15-.894z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                    </button>
                    {isModelDropdownOpen && (
                        <div className={`absolute bottom-[120%] left-0 mb-2 w-80 rounded-[2rem] shadow-2xl z-50 overflow-hidden border ${theme === 'dark' ? 'glass-dark-solid' : 'glass-light-solid'}`}>
                          <div className={`flex p-3 border-b ${theme === 'dark' ? 'border-white/10' : 'border-black/10'}`}>
                            <button type="button" onClick={() => updateAgentModeSettings(false)} className={`flex-1 py-2.5 text-[11px] font-bold uppercase tracking-widest rounded-xl transition-all duration-300 ease-spring ${!isAgentMode ? (theme === 'dark' ? 'bg-white/10 text-white' : 'bg-white text-black shadow-md') : (theme === 'dark' ? 'text-[#A1A1AA] hover:text-white' : 'text-[#71717A] hover:text-black')}`}>Standard</button>
                            <button type="button" onClick={() => updateAgentModeSettings(true)} className={`flex-1 py-2.5 text-[11px] font-bold uppercase tracking-widest rounded-xl transition-all duration-300 ease-spring flex items-center justify-center gap-2 ${isAgentMode ? 'bg-indigo-500/20 text-indigo-400 shadow-[inset_0_0_0_1px_rgba(99,102,241,0.2)]' : (theme === 'dark' ? 'text-[#A1A1AA] hover:text-white' : 'text-[#71717A] hover:text-black')}`}>
                              <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" /></svg>
                              Swarm
                            </button>
                          </div>

                          <div className="p-4 max-h-[60vh] overflow-y-auto custom-scrollbar">
                            {!isAgentMode ? (
                              <div className="space-y-2">
                                <div className={`text-[10px] font-semibold uppercase tracking-widest mb-3 mt-1 ${theme === 'dark' ? 'text-[#71717A]' : 'text-[#A1A1AA]'}`}>Model Selection</div>
                                {['deepseek-v4-flash', 'deepseek-v4-pro', 'qwen3.7-plus', 'qwen3.7-max'].map(modelId => (
                                  <button key={modelId} type="button" onClick={() => { updateChatModel(modelId); setIsModelDropdownOpen(false); }} className={`w-full text-left px-4 py-3 text-[13px] tracking-wide rounded-xl transition-all duration-300 ease-spring ${activeModel === modelId ? (theme === 'dark' ? 'text-white bg-white/10 font-medium' : 'text-black bg-black/5 font-medium') : (theme === 'dark' ? 'text-[#A1A1AA] hover:text-white hover:bg-white/5' : 'text-[#71717A] hover:text-black hover:bg-black/5')}`}>
                                    {modelId.replace(/-/g, ' ').toUpperCase()}
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <div className="space-y-6">
                                <div>
                                  <div className={`text-[10px] font-semibold uppercase tracking-widest mb-3 ${theme === 'dark' ? 'text-[#71717A]' : 'text-[#A1A1AA]'}`}>Manager Node</div>
                                  <div className="grid grid-cols-2 gap-2">
                                    {['deepseek-v4-pro', 'qwen3.7-max', 'deepseek-v4-flash', 'qwen3.7-plus'].map(modelId => (
                                      <button key={modelId} type="button" onClick={() => updateChatModel(modelId)} className={`text-left px-3 py-2.5 text-[11px] tracking-wide rounded-xl border transition-all duration-300 ease-spring ${activeModel === modelId ? 'border-indigo-500 bg-indigo-500/10 text-indigo-400 font-semibold shadow-[0_0_10px_rgba(99,102,241,0.2)]' : (theme === 'dark' ? 'border-white/10 text-[#A1A1AA] hover:border-white/30' : 'border-black/10 text-[#71717A] hover:border-black/30')}`}>
                                        {modelId.split('-').pop()?.toUpperCase()}
                                      </button>
                                    ))}
                                  </div>
                                </div>

                                <div>
                                  <div className={`text-[10px] font-semibold uppercase tracking-widest mb-3 ${theme === 'dark' ? 'text-[#71717A]' : 'text-[#A1A1AA]'}`}>Swarm Logic Tier</div>
                                  <div className="space-y-2">
                                    <button type="button" onClick={() => updateSwarmTier('smart')} className={`w-full flex flex-col items-start p-3 rounded-xl border transition-all duration-300 ease-spring ${swarmTier === 'smart' ? 'border-indigo-500 bg-indigo-500/10 text-indigo-400 shadow-[0_0_10px_rgba(99,102,241,0.1)]' : (theme === 'dark' ? 'border-white/10 text-[#D4D4D8] hover:bg-white/5' : 'border-black/10 text-[#3F3F46] hover:bg-black/5')}`}>
                                      <span className="font-semibold text-[13px]">Smart</span>
                                      <span className={`text-[11px] mt-1 ${theme === 'dark' ? 'text-[#71717A]' : 'text-[#A1A1AA]'}`}>Conserves tokens (Flash workers)</span>
                                    </button>
                                    <button type="button" onClick={() => updateSwarmTier('smarter')} className={`w-full flex flex-col items-start p-3 rounded-xl border transition-all duration-300 ease-spring ${swarmTier === 'smarter' ? 'border-indigo-500 bg-indigo-500/10 text-indigo-400 shadow-[0_0_10px_rgba(99,102,241,0.1)]' : (theme === 'dark' ? 'border-white/10 text-[#D4D4D8] hover:bg-white/5' : 'border-black/10 text-[#3F3F46] hover:bg-black/5')}`}>
                                      <span className="font-semibold text-[13px]">Smarter</span>
                                      <span className={`text-[11px] mt-1 ${theme === 'dark' ? 'text-[#71717A]' : 'text-[#A1A1AA]'}`}>Balanced (Pro / Plus workers)</span>
                                    </button>
                                    <button type="button" onClick={() => updateSwarmTier('smartest')} className={`w-full flex flex-col items-start p-3 rounded-xl border transition-all duration-300 ease-spring ${swarmTier === 'smartest' ? 'border-indigo-500 bg-indigo-500/10 text-indigo-400 shadow-[0_0_10px_rgba(99,102,241,0.1)]' : (theme === 'dark' ? 'border-white/10 text-[#D4D4D8] hover:bg-white/5' : 'border-black/10 text-[#3F3F46] hover:bg-black/5')}`}>
                                      <span className="font-semibold text-[13px]">Smartest</span>
                                      <span className={`text-[11px] mt-1 ${theme === 'dark' ? 'text-[#71717A]' : 'text-[#A1A1AA]'}`}>Maximum logic (Pro / Max workers)</span>
                                    </button>
                                  </div>
                                </div>

                                <div>
                                  <div className="flex justify-between items-center mb-3">
                                    <div className={`text-[10px] font-semibold uppercase tracking-widest ${theme === 'dark' ? 'text-[#71717A]' : 'text-[#A1A1AA]'}`}>Max Agents</div>
                                    <span className={`text-[13px] font-medium ${theme === 'dark' ? 'text-[#F4F4F5]' : 'text-[#18181B]'}`}>{maxAgents}</span>
                                  </div>
                                  <input type="range" min="1" max="10" value={maxAgents} onChange={(e) => updateMaxAgents(Number(e.target.value))} className="w-full accent-indigo-500 h-1.5 rounded-full appearance-none cursor-pointer bg-black/10 dark:bg-white/10" />
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                  </div>

                  {/* Attachment Button */}
                  <div className={`flex-shrink-0 transition-all ${isInputExpanded ? 'order-3' : 'order-2'}`}>
                    <button type="button" onClick={() => fileInputRef.current?.click()} className={`h-12 w-12 flex items-center justify-center transition-all duration-300 ease-spring rounded-[1.25rem] opacity-50 hover:opacity-100 ${theme === 'dark' ? 'text-[#F4F4F5]' : 'text-[#18181B]'}`} title="Attach file">
                      <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" /></svg>
                    </button>
                  </div>
                  
                  <input type="file" ref={fileInputRef} onChange={handleFileChange} multiple className="hidden" accept=".txt,.html,.css,.js,.php,.pdf,.md,.csv,.json,.png,.jpg,.jpeg,.webp" />

                  <textarea
                    ref={textareaRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(e as any); } }}
                    placeholder={isAgentMode ? (activeProposedPlan ? "Approve the plan ('ok', 'proceed') or type modifications..." : "Provide details for the Manager to build a plan...") : "Message..."}
                    className={`bg-transparent px-3 py-3 focus:outline-none resize-none overflow-y-auto font-light text-[15px] transition-all duration-300 ${theme === 'dark' ? 'text-[#F4F4F5] placeholder-[#71717A]' : 'text-[#18181B] placeholder-[#A1A1AA]'} ${isInputExpanded ? 'order-1 basis-full w-full mb-1' : 'order-3 flex-1 min-w-0'}`}
                    disabled={isLoading}
                    rows={1}
                    style={{ minHeight: '48px', maxHeight: '300px', lineHeight: '24px' }}
                  />

                  <div className={`flex flex-row items-center gap-2 flex-shrink-0 transition-all ${isInputExpanded ? 'order-4 ml-auto' : 'order-4'}`}>
                    <button type="submit" disabled={isLoading || (!input.trim() && attachments.length === 0)} className={`h-12 w-12 flex items-center justify-center rounded-[1.25rem] focus:outline-none transition-all duration-300 ease-spring ${!isLoading && (input.trim() || attachments.length > 0) ? 'active:scale-90 scale-100' : 'scale-95 opacity-50'} ${(input.trim() || attachments.length > 0) && !isLoading ? (isAgentMode ? "bg-indigo-600 text-white hover:bg-indigo-500 shadow-[0_0_20px_rgba(79,70,229,0.3)]" : (theme === 'dark' ? "bg-white text-[#0A0A0A] hover:bg-[#E5E5E5] shadow-[0_0_20px_rgba(255,255,255,0.1)]" : "bg-black text-white hover:bg-[#1A1A1A] shadow-[0_0_20px_rgba(0,0,0,0.1)]")) : (theme === 'dark' ? "bg-white/5 text-[#A1A1AA] cursor-not-allowed" : "bg-black/5 text-[#71717A] cursor-not-allowed")}`}>
                      <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5"><path fillRule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25zm.53 5.47a.75.75 0 00-1.06 0l-3 3a.75.75 0 101.06 1.06l1.72-1.72v5.69a.75.75 0 001.5 0v-5.69l1.72 1.72a.75.75 0 101.06-1.06l-3-3z" clipRule="evenodd" /></svg>
                    </button>
                  </div>
                </div>
              </form>

              {/* NEW MODE INDICATOR BELOW INPUT */}
              <div className="absolute -bottom-6 left-0 right-0 flex justify-center pointer-events-none">
                 <div className={`flex items-center gap-2 text-[9px] font-mono font-medium tracking-widest uppercase opacity-60 ${theme === 'dark' ? 'text-white' : 'text-black'}`}>
                    {isAgentMode ? (
                       <span className="flex items-center gap-1.5 text-indigo-500">
                          <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-2.5 h-2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" /></svg>
                          SWARM ({swarmTier})
                       </span>
                    ) : (
                       <span>STANDARD</span>
                    )}
                    <span className="opacity-50 mx-1">•</span>
                    <span>{activeModel.replace('deepseek-v4-', 'DS-').replace('qwen3.7-', 'QW-').replace(/-/g, ' ')}</span>
                 </div>
              </div>
              
            </div>
          </div>

          <div ref={filesPanelRef} className={`fixed inset-y-0 right-0 w-[22rem] shadow-[0_0_50px_rgba(0,0,0,0.2)] z-50 transform transition-transform duration-500 ease-spring flex flex-col ${isFilesPanelOpen ? 'translate-x-0' : 'translate-x-full'} ${theme === 'dark' ? 'glass-dark border-l border-white/5' : 'glass-light border-l border-black/5'}`}>
             <div className={`p-6 border-b flex items-center justify-between flex-shrink-0 ${theme === 'dark' ? 'border-white/5' : 'border-black/5'}`}>
                <div>
                   <h2 className={`text-[11px] tracking-widest uppercase font-bold flex items-center gap-2 ${theme === 'dark' ? 'text-[#F4F4F5]' : 'text-[#18181B]'}`}>
                      <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 text-indigo-500"><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" /></svg>
                      Workspace
                   </h2>
                   <p className={`text-[11px] mt-1.5 mb-0 ${theme === 'dark' ? 'text-[#A1A1AA]' : 'text-[#71717A]'}`}>{sortedFilesInChat.length} total files generated</p>
                </div>
                <button onClick={() => setIsFilesPanelOpen(false)} className={`p-2 rounded-full transition-all active:scale-90 ${theme === 'dark' ? 'hover:bg-white/10 text-[#A1A1AA] hover:text-white' : 'hover:bg-black/5 text-[#71717A] hover:text-black'}`}>
                   <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
             </div>
             
             <div className={`px-6 py-3 flex items-center gap-3 border-b flex-shrink-0 ${theme === 'dark' ? 'border-white/5 bg-black/20' : 'border-black/5 bg-white/40'}`}>
                <span className={`text-[10px] font-bold uppercase tracking-widest ${theme === 'dark' ? 'text-[#71717A]' : 'text-[#A1A1AA]'}`}>Sort by:</span>
                <div className={`flex rounded-lg p-1 ${theme === 'dark' ? 'bg-white/5' : 'bg-black/5'}`}>
                   <button onClick={() => setFileSortOrder('name')} className={`px-3 py-1.5 text-[10px] uppercase tracking-wider rounded-md transition-all duration-300 ease-spring ${fileSortOrder === 'name' ? (theme === 'dark' ? 'bg-white/10 text-white shadow-sm' : 'bg-white text-black shadow-sm') : (theme === 'dark' ? 'text-[#A1A1AA] hover:text-white' : 'text-[#71717A] hover:text-black')}`}>Name</button>
                   <button onClick={() => setFileSortOrder('type')} className={`px-3 py-1.5 text-[10px] uppercase tracking-wider rounded-md transition-all duration-300 ease-spring ${fileSortOrder === 'type' ? (theme === 'dark' ? 'bg-white/10 text-white shadow-sm' : 'bg-white text-black shadow-sm') : (theme === 'dark' ? 'text-[#A1A1AA] hover:text-white' : 'text-[#71717A] hover:text-black')}`}>Type</button>
                </div>
             </div>

             <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                {sortedFilesInChat.length === 0 ? (
                   <div className="h-full flex flex-col items-center justify-center opacity-50 space-y-4">
                      <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor" className="w-12 h-12"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg>
                      <p className="text-[13px] font-light tracking-wide">Workspace is empty.</p>
                   </div>
                ) : (
                   <div className="space-y-2">
                      {sortedFilesInChat.map((file, idx) => {
                         const extension = file.name.split('.').pop()?.toUpperCase() || 'TXT';
                         return (
                            <div key={idx} className={`group flex items-center justify-between p-3.5 rounded-2xl transition-all duration-300 ease-spring ${theme === 'dark' ? 'hover:bg-white/5' : 'hover:bg-black/5'}`}>
                               <div className="flex items-center space-x-4 overflow-hidden pr-3 w-full">
                                  <span className={`flex-shrink-0 text-[10px] font-mono font-bold w-10 text-center py-1.5 rounded-lg bg-opacity-20 ${
                                     extension === 'PY' ? 'text-blue-500 bg-blue-500' : 
                                     extension === 'JSON' ? 'text-yellow-500 bg-yellow-500' :
                                     extension === 'TSX' || extension === 'TS' ? 'text-blue-400 bg-blue-400' :
                                     theme === 'dark' ? 'text-[#A1A1AA] bg-white' : 'text-[#71717A] bg-black'
                                  }`}>{extension}</span>
                                  <span className={`truncate text-[13px] tracking-wide ${theme === 'dark' ? 'text-[#D4D4D8]' : 'text-[#3F3F46]'}`}>{file.name}</span>
                               </div>
                               <button onClick={() => downloadFile(file.name, file.content)} className={`opacity-0 group-hover:opacity-100 transition-all duration-300 active:scale-90 p-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-500 shadow-[0_0_10px_rgba(79,70,229,0.3)] flex-shrink-0`} title="Download File">
                                  <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
                               </button>
                            </div>
                         );
                      })}
                   </div>
                )}
             </div>
             
             {sortedFilesInChat.length > 0 && (
                <div className={`p-6 border-t flex-shrink-0 ${theme === 'dark' ? 'border-white/5 bg-black/20' : 'border-black/5 bg-white/40'}`}>
                   <button onClick={() => downloadProjectZip(sortedFilesInChat, "Workspace_Files")} className="w-full flex items-center justify-center gap-2 px-6 py-3.5 bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-bold uppercase tracking-widest rounded-full transition-all duration-300 ease-spring active:scale-95 shadow-[0_0_20px_rgba(79,70,229,0.3)]">
                      <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 14.15v4.25c0 1.08-.88 1.95-1.95 1.95H5.7c-1.08 0-1.95-.88-1.95-1.95v-4.25m16.5 0a2.18 2.18 0 00-1.51-.58H7.21c-.58 0-1.12.23-1.51.58m16.5 0v-2.35c0-1.08-.88-1.95-1.95-1.95H5.7c-1.08 0-1.95.88-1.95 1.95v2.35m16.5 0H3.75m10.5-8.25L12 3m0 0L7.5 8.25M12 3v11.25" /></svg>
                      Download All (ZIP)
                   </button>
                </div>
             )}
          </div>
        </main>
        
        {isSidebarOpen && <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-20 md:hidden transition-opacity" onClick={() => setIsSidebarOpen(false)} />}
        {isFilesPanelOpen && <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40 transition-opacity" onClick={() => setIsFilesPanelOpen(false)} />}
      </div>
    </>
  );
}
