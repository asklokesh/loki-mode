import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Send, Square, MessageSquare, FileCode2, Terminal as TerminalIcon, Wrench, Image as ImageIcon, X } from 'lucide-react';
import { api } from '../api/client';
import { Button } from './ui/Button';
import { useSubmitGuard } from '../hooks/useSubmitGuard';

interface AIChatPanelProps {
  sessionId: string;
  defaultMode?: 'quick' | 'standard' | 'max';
  onFilesChanged?: (files: string[]) => void;
  services?: Array<{name: string; fix_status?: string}>;
}

interface ChatMessage {
  role: 'user' | 'system';
  content: string;
  timestamp: string;
  filesChanged?: string[];
  isStreaming?: boolean;
  returncode?: number;
  imageUrl?: string;
  imageName?: string;
}

// Immutable update helper: replaces the last message with a new object
function updateLastMessage(
  prev: ChatMessage[],
  updater: (msg: ChatMessage) => Partial<ChatMessage>,
): ChatMessage[] {
  if (prev.length === 0) return prev;
  const updated = [...prev];
  const last = updated[updated.length - 1];
  updated[updated.length - 1] = { ...last, ...updater(last) };
  return updated;
}

/** Parse categorized output lines into structured sections for display. */
function parseStructuredContent(content: string): {
  textLines: string[];
  fileChanges: string[];
  commands: string[];
} {
  const textLines: string[] = [];
  const fileChanges: string[] = [];
  const commands: string[] = [];

  for (const line of content.split('\n')) {
    if (line.startsWith('__FILE_CHANGE__')) {
      fileChanges.push(line.replace('__FILE_CHANGE__', ''));
    } else if (line.startsWith('__COMMAND__')) {
      commands.push(line.replace('__COMMAND__', ''));
    } else {
      textLines.push(line);
    }
  }
  return { textLines, fileChanges, commands };
}

function ChatMessageBubble({ msg }: { msg: ChatMessage }) {
  const [showFullOutput, setShowFullOutput] = useState(false);
  const parsed = useMemo(
    () => msg.role === 'system' ? parseStructuredContent(msg.content) : null,
    [msg.role, msg.content],
  );

  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] max-md:max-w-[90%] rounded-lg px-3 py-2 max-md:px-4 max-md:py-3 text-xs max-md:text-sm bg-primary/10 text-ink">
          {msg.imageUrl && (
            <div className="mb-2">
              <img
                src={msg.imageUrl}
                alt={msg.imageName || 'Uploaded image'}
                className="max-w-full max-h-48 rounded border border-border object-contain"
              />
              {msg.imageName && (
                <span className="text-[10px] text-muted mt-0.5 block">{msg.imageName}</span>
              )}
            </div>
          )}
          <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed overflow-x-auto">{msg.content}</pre>
        </div>
      </div>
    );
  }

  // System message with structured output
  const textContent = parsed ? parsed.textLines.join('\n').trim() : msg.content;
  const isLong = textContent.split('\n').length > 30;

  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] max-md:max-w-[90%] rounded-lg px-3 py-2 max-md:px-4 max-md:py-3 text-xs max-md:text-sm bg-hover text-ink border-l-2 border-primary/40">
        {/* Commands executed */}
        {parsed && parsed.commands.length > 0 && (
          <div className="mb-2 space-y-0.5">
            {parsed.commands.map((cmd, j) => (
              <div key={j} className="flex items-center gap-1.5 text-[11px] font-mono text-muted bg-card/50 px-2 py-0.5 rounded">
                <TerminalIcon size={10} className="text-muted/60 flex-shrink-0" />
                <span className="truncate">{cmd}</span>
              </div>
            ))}
          </div>
        )}

        {/* Main text content */}
        <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed overflow-x-auto">
          {isLong && !showFullOutput ? textContent.split('\n').slice(0, 30).join('\n') + '\n...' : textContent}
          {msg.isStreaming && (
            <span className="inline-block w-1.5 h-3.5 bg-primary/60 animate-pulse ml-0.5 align-text-bottom" />
          )}
        </pre>
        {isLong && !msg.isStreaming && (
          <button
            onClick={() => setShowFullOutput(v => !v)}
            className="text-[10px] text-primary hover:text-primary/80 mt-1 font-medium"
          >
            {showFullOutput ? 'Show less' : `Show all (${textContent.split('\n').length} lines)`}
          </button>
        )}

        {/* File changes from categorized output */}
        {parsed && parsed.fileChanges.length > 0 && (
          <div className="mt-2 pt-2 border-t border-border">
            <span className="text-[11px] text-muted font-semibold uppercase flex items-center gap-1">
              <FileCode2 size={11} />
              Files modified ({parsed.fileChanges.length})
            </span>
            <ul className="mt-1 space-y-0.5">
              {parsed.fileChanges.map((f, j) => (
                <li key={j} className="text-[11px] font-mono text-primary/80">{f}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Git-detected file changes */}
        {msg.filesChanged && msg.filesChanged.length > 0 && (
          <div className="mt-2 pt-2 border-t border-border">
            <span className="text-[11px] text-muted font-semibold uppercase flex items-center gap-1">
              <FileCode2 size={11} />
              Changed files ({msg.filesChanged.length})
            </span>
            <ul className="mt-1 space-y-0.5">
              {msg.filesChanged.map((f, j) => (
                <li key={j} className="text-[11px] font-mono text-muted">{f}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Summary line */}
        {msg.role === 'system' && !msg.isStreaming && msg.returncode !== undefined && (
          <div className="mt-1 text-[10px] text-muted">
            {msg.returncode === 0 ? (
              <span>
                Done
                {parsed && (parsed.fileChanges.length > 0 || (msg.filesChanged && msg.filesChanged.length > 0))
                  ? ` -- ${parsed.fileChanges.length + (msg.filesChanged?.length || 0)} files changed`
                  : ''}
                {parsed && parsed.commands.length > 0 ? `, ${parsed.commands.length} commands run` : ''}
              </span>
            ) : (
              <span className="text-red-400">
                Task failed. {msg.returncode === 124 ? 'Timed out.' : 'Check the output above for error details.'}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const modeDescriptions: Record<string, string> = {
  quick: 'Quick: Fast single-task fix (3 iterations max)',
  standard: 'Standard: Thorough implementation with testing',
  max: 'Max: Full autonomous build from your description',
};

export function AIChatPanel({ sessionId, defaultMode, onFilesChanged, services }: AIChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<'quick' | 'standard' | 'max'>(defaultMode || 'quick');
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [pendingImage, setPendingImage] = useState<{ file: File; previewUrl: string } | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeTaskRef = useRef<string | null>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  // UX-001: Restore chat history from sessionStorage on mount
  useEffect(() => {
    const saved = sessionStorage.getItem(`chat_${sessionId}`);
    if (saved) {
      try { setMessages(JSON.parse(saved)); } catch { /* ignore corrupt data */ }
    }
  }, [sessionId]);

  // UX-001: Persist chat history to sessionStorage (last 50 messages)
  useEffect(() => {
    if (messages.length > 0) {
      sessionStorage.setItem(`chat_${sessionId}`, JSON.stringify(messages.slice(-50)));
    }
  }, [messages, sessionId]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
      // Revoke object URL to prevent memory leaks
      if (pendingImage?.previewUrl) {
        URL.revokeObjectURL(pendingImage.previewUrl);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle image file selection
  const handleImageFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) return;
    // Revoke previous preview URL
    if (pendingImage?.previewUrl) {
      URL.revokeObjectURL(pendingImage.previewUrl);
    }
    const previewUrl = URL.createObjectURL(file);
    setPendingImage({ file, previewUrl });
  }, [pendingImage?.previewUrl]);

  const clearPendingImage = useCallback(() => {
    if (pendingImage?.previewUrl) {
      URL.revokeObjectURL(pendingImage.previewUrl);
    }
    setPendingImage(null);
  }, [pendingImage?.previewUrl]);

  // Clipboard paste handler (Ctrl+V for images)
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) handleImageFile(file);
          return;
        }
      }
    };
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [handleImageFile]);

  // Drag-and-drop handlers
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const file = files[0];
      if (file.type.startsWith('image/')) {
        handleImageFile(file);
      }
    }
  }, [handleImageFile]);

  const handleCancel = useCallback(async () => {
    // Abort the fetch stream
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    // Tell the server to kill the process
    if (activeTaskRef.current) {
      try {
        await api.chatCancel(sessionId, activeTaskRef.current);
      } catch {
        // Best effort -- task may already be done
      }
      activeTaskRef.current = null;
    }
    setStreaming(false);
    setSending(false);
    // Mark the last streaming message as no longer streaming
    setMessages(prev =>
      updateLastMessage(prev, last =>
        last.isStreaming
          ? { isStreaming: false, content: last.content + '\n[cancelled]' }
          : {},
      ),
    );
    inputRef.current?.focus();
  }, [sessionId]);

  const fallbackToPoll = useCallback(async (taskId: string) => {
    // Polling fallback for environments that do not support SSE streaming
    const maxPolls = 150;
    let pollCount = 0;
    let poll: { complete: boolean; output_lines: string[]; files_changed: string[]; returncode: number };

    do {
      await new Promise(r => setTimeout(r, 2000));
      poll = await api.chatPoll(sessionId, taskId);
      pollCount++;

      // Update streaming message with partial output
      if (poll.output_lines.length > 0) {
        const joined = poll.output_lines.join('\n');
        setMessages(prev =>
          updateLastMessage(prev, last =>
            last.role === 'system' && last.isStreaming ? { content: joined } : {},
          ),
        );
      }

      if (pollCount >= maxPolls) {
        poll = { complete: true, output_lines: ['Task timed out after 5 minutes. The AI may still be working in the background. Try checking the terminal or refreshing.'], files_changed: [], returncode: 1 };
      }
    } while (!poll.complete);

    setMessages(prev =>
      updateLastMessage(prev, last =>
        last.role === 'system'
          ? {
              isStreaming: false,
              content: poll.output_lines.join('\n') || 'Done.',
              filesChanged: poll.files_changed,
              returncode: poll.returncode,
            }
          : {},
      ),
    );

    if (poll.files_changed?.length > 0 && onFilesChanged) {
      onFilesChanged(poll.files_changed);
    }
  }, [sessionId, onFilesChanged]);

  const startStreaming = useCallback(async (taskId: string) => {
    const controller = new AbortController();
    abortRef.current = controller;
    activeTaskRef.current = taskId;
    setStreaming(true);

    try {
      const streamUrl = api.chatStreamUrl(sessionId, taskId);
      const response = await fetch(streamUrl, { signal: controller.signal });

      if (!response.ok || !response.body) {
        throw new Error(`Stream failed: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer -- events are separated by double newlines
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          if (!part.trim()) continue;

          const lines = part.split('\n');
          let eventType = '';
          let data = '';

          for (const line of lines) {
            if (line.startsWith('event:')) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              data = line.slice(5).trim();
            }
          }

          if (eventType === 'output' && data) {
            try {
              const { line } = JSON.parse(data);
              setMessages(prev =>
                updateLastMessage(prev, last =>
                  last.role === 'system' && last.isStreaming
                    ? { content: last.content ? last.content + '\n' + line : line }
                    : {},
                ),
              );
            } catch {
              // Skip malformed JSON
            }
          } else if (eventType === 'complete' && data) {
            try {
              const { returncode, files_changed } = JSON.parse(data);
              setMessages(prev =>
                updateLastMessage(prev, last =>
                  last.role === 'system' && last.isStreaming
                    ? {
                        isStreaming: false,
                        filesChanged: files_changed,
                        returncode,
                        content: last.content || 'Done.',
                      }
                    : {},
                ),
              );
              // Notify parent about changed files for file tree refresh
              if (files_changed?.length > 0 && onFilesChanged) {
                onFilesChanged(files_changed);
              }
            } catch {
              // Skip malformed JSON
            }
          } else if (eventType === 'error' && data) {
            try {
              const { error } = JSON.parse(data);
              setMessages(prev =>
                updateLastMessage(prev, last =>
                  last.role === 'system' && last.isStreaming
                    ? { isStreaming: false, content: `Error: ${error}` }
                    : {},
                ),
              );
            } catch {
              // Skip malformed JSON
            }
          }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // User cancelled -- already handled
        return;
      }
      // SSE failed -- fall back to polling
      await fallbackToPoll(taskId);
    } finally {
      setStreaming(false);
      setSending(false);
      abortRef.current = null;
      activeTaskRef.current = null;
      inputRef.current?.focus();
    }
  }, [sessionId, onFilesChanged, fallbackToPoll]);

  const handleSend = async () => {
    const trimmed = input.trim();
    if ((!trimmed && !pendingImage) || sending) return;

    // Upload image first if present
    let imageUrl: string | undefined;
    let imageName: string | undefined;
    let imageContext = '';

    if (pendingImage) {
      setUploadingImage(true);
      try {
        const result = await api.chatImageUpload(sessionId, pendingImage.file);
        imageUrl = pendingImage.previewUrl;
        imageName = result.filename;
        imageContext = `[Attached image: ${result.filename} (id: ${result.image_id})] Make it look like this. `;
      } catch {
        // Continue without image if upload fails
      }
      setUploadingImage(false);
    }

    const messageText = imageContext + (trimmed || 'Make changes based on this screenshot.');

    const userMsg: ChatMessage = {
      role: 'user',
      content: trimmed || 'Make changes based on this screenshot.',
      timestamp: new Date().toISOString(),
      imageUrl,
      imageName,
    };

    // Add user message and a placeholder streaming system message
    const streamingMsg: ChatMessage = {
      role: 'system',
      content: '',
      timestamp: new Date().toISOString(),
      isStreaming: true,
    };

    setMessages(prev => [...prev, userMsg, streamingMsg]);
    setInput('');
    setPendingImage(null);
    setSending(true);

    try {
      // BUG-E2E-004: Send recent conversation history for context continuity.
      const historyForContext = messages
        .filter(m => (m.role === 'user' || (m.role === 'system' && !m.isStreaming && m.content)))
        .slice(-10)
        .map(m => ({
          role: m.role === 'user' ? 'user' as const : 'assistant' as const,
          content: m.content,
        }));
      const { task_id } = await api.chatStart(sessionId, messageText, mode, historyForContext.length > 0 ? historyForContext : undefined);
      await startStreaming(task_id);
    } catch (err) {
      setMessages(prev =>
        updateLastMessage(prev, last =>
          last.role === 'system' && last.isStreaming
            ? { isStreaming: false, content: `Error: ${err instanceof Error ? err.message : 'Request failed'}` }
            : {},
        ),
      );
      setSending(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div
      ref={dropZoneRef}
      className={`flex flex-col h-full relative max-md:fixed max-md:inset-0 max-md:z-40 max-md:bg-white dark:max-md:bg-[#1A1A1E] ${isDragOver ? 'ring-2 ring-primary ring-inset' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-primary/5 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 text-primary">
            <ImageIcon size={32} />
            <span className="text-sm font-medium">Drop image here</span>
          </div>
        </div>
      )}

      {/* Messages area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 max-md:p-4 space-y-3 max-md:space-y-4 terminal-scroll scroll-smooth-bottom">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <MessageSquare size={28} className="text-muted/30 mb-3" />
            <p className="text-xs text-muted font-medium">No messages yet</p>
            <p className="text-[11px] text-muted/70 mt-1 max-w-[200px]">
              Ask the AI to build, modify, or explain your code. Drop an image or paste a screenshot.
            </p>
          </div>
        )}
        {messages.map((msg, i) => (
          <ChatMessageBubble key={i} msg={msg} />
        ))}
      </div>

      {/* Input area */}
      <div className="border-t border-border p-2 max-md:p-3 flex-shrink-0">
        {/* Status bar when streaming */}
        {streaming && (
          <div className="flex items-center justify-between mb-2 px-1">
            <span className="text-[10px] text-muted font-mono">Streaming...</span>
            <button
              onClick={handleCancel}
              className="flex items-center gap-1 text-[10px] text-red-400 hover:text-red-300 transition-colors"
            >
              <Square className="w-2.5 h-2.5" />
              Stop
            </button>
          </div>
        )}
        {/* Auto-fix indicator */}
        {!streaming && services?.some(s => s.fix_status === 'fixing') && (
          <div className="flex items-center gap-1.5 mb-2 px-1">
            <Wrench size={10} className="text-yellow-400 animate-spin" />
            <span className="text-[10px] text-yellow-400 font-mono">
              Auto-fixing: {services.find(s => s.fix_status === 'fixing')?.name}
            </span>
          </div>
        )}
        {/* Mode toggle */}
        <div className="flex items-center gap-1 mb-2">
          {(['quick', 'standard', 'max'] as const).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              title={modeDescriptions[m]}
              className={`text-xs font-semibold px-3 py-1.5 rounded-btn transition-colors capitalize ${
                mode === m ? 'bg-primary text-white' : 'text-muted hover:text-ink'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        {/* Pending image preview */}
        {pendingImage && (
          <div className="flex items-center gap-2 mb-2 px-1">
            <div className="relative">
              <img
                src={pendingImage.previewUrl}
                alt="Pending upload"
                className="h-16 max-w-[120px] rounded border border-border object-cover"
              />
              <button
                onClick={clearPendingImage}
                className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-red-500 text-white rounded-full flex items-center justify-center hover:bg-red-600"
                title="Remove image"
              >
                <X size={10} />
              </button>
            </div>
            <span className="text-[10px] text-muted truncate max-w-[150px]">{pendingImage.file.name}</span>
            {uploadingImage && <span className="text-[10px] text-primary animate-pulse">Uploading...</span>}
          </div>
        )}
        {/* Input + send */}
        <div className="flex items-center gap-2">
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleImageFile(file);
              e.target.value = '';
            }}
          />
          {/* Image upload button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={sending}
            className="p-1.5 text-muted hover:text-primary rounded transition-colors disabled:opacity-50"
            title="Attach image (or paste/drag-and-drop)"
          >
            <ImageIcon size={16} />
          </button>
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Ask AI to modify your project... (Shift+Enter for new line)"
            rows={1}
            className="flex-1 px-3 py-1.5 max-md:py-3 max-md:text-base text-xs bg-card border border-border rounded-btn outline-none focus:border-primary transition-colors resize-none"
            style={{ maxHeight: '120px', overflow: 'auto' }}
            disabled={sending}
          />
          {streaming ? (
            <Button
              size="sm"
              icon={Square}
              onClick={handleCancel}
              aria-label="Stop streaming"
              className="bg-red-500/10 hover:bg-red-500/20 text-red-400"
            >
              Stop
            </Button>
          ) : (
            <Button
              size="sm"
              icon={Send}
              onClick={handleSend}
              disabled={sending || (!input.trim() && !pendingImage)}
              aria-label="Send message"
            >
              Send
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
