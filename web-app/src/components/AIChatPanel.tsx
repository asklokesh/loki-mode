import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Send, Square, MessageSquare, FileCode2, Terminal as TerminalIcon, Wrench, Image as ImageIcon, X, ThumbsUp, ThumbsDown, FileText, LayoutTemplate, BookOpen, AtSign } from 'lucide-react';
import { api } from '../api/client';
import { Button } from './ui/Button';
import { SmartSuggestions } from './SmartSuggestions';

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

// ---------------------------------------------------------------------------
// Message reactions (H90) -- thumbs up/down feedback on AI messages
// ---------------------------------------------------------------------------

function MessageReactions({ msgIndex }: { msgIndex: number }) {
  const [reaction, setReaction] = useState<'up' | 'down' | null>(null);

  const handleReaction = (type: 'up' | 'down') => {
    setReaction(reaction === type ? null : type);
  };

  return (
    <div className="flex items-center gap-1 mt-1">
      <button
        onClick={() => handleReaction('up')}
        className={`p-1 rounded transition-colors ${
          reaction === 'up'
            ? 'text-primary bg-primary/10'
            : 'text-muted/40 hover:text-primary hover:bg-primary/5'
        }`}
        title="Helpful response"
        aria-label="Thumbs up"
      >
        <ThumbsUp size={12} />
      </button>
      <button
        onClick={() => handleReaction('down')}
        className={`p-1 rounded transition-colors ${
          reaction === 'down'
            ? 'text-red-400 bg-red-400/10'
            : 'text-muted/40 hover:text-red-400 hover:bg-red-400/5'
        }`}
        title="Not helpful"
        aria-label="Thumbs down"
      >
        <ThumbsDown size={12} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// @mention autocomplete (H89)
// ---------------------------------------------------------------------------

interface MentionOption {
  id: string;
  label: string;
  description: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}

const MENTION_OPTIONS: MentionOption[] = [
  { id: '@file', label: '@file', description: 'Reference a file in your project', icon: FileCode2 },
  { id: '@template', label: '@template', description: 'Reference a template', icon: LayoutTemplate },
  { id: '@docs', label: '@docs', description: 'Reference documentation', icon: BookOpen },
];

function MentionAutocomplete({
  visible,
  filter,
  onSelect,
  onClose,
  selectedIndex,
}: {
  visible: boolean;
  filter: string;
  onSelect: (mention: string) => void;
  onClose: () => void;
  selectedIndex: number;
}) {
  if (!visible) return null;

  const filtered = MENTION_OPTIONS.filter((opt) =>
    opt.label.toLowerCase().includes(filter.toLowerCase()),
  );

  if (filtered.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 bg-card border border-border rounded-lg shadow-lg py-1 z-50">
      <div className="px-3 py-1">
        <span className="text-[10px] text-muted font-semibold uppercase tracking-wider flex items-center gap-1">
          <AtSign size={10} />
          Mentions
        </span>
      </div>
      {filtered.map((opt, i) => {
        const Icon = opt.icon;
        return (
          <button
            key={opt.id}
            onClick={() => onSelect(opt.label)}
            className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors text-left ${
              i === selectedIndex ? 'bg-primary/10 text-primary' : 'text-ink hover:bg-hover'
            }`}
          >
            <Icon size={14} className={i === selectedIndex ? 'text-primary' : 'text-muted'} />
            <span className="font-medium">{opt.label}</span>
            <span className="text-muted text-[11px]">{opt.description}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Typing indicator (H94) -- "Loki is thinking..."
// ---------------------------------------------------------------------------

function TypingIndicator() {
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <div className="flex items-center gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce" style={{ animationDelay: '0ms' }} />
        <span className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce" style={{ animationDelay: '150ms' }} />
        <span className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce" style={{ animationDelay: '300ms' }} />
      </div>
      <span className="text-[11px] text-muted italic">Loki is thinking...</span>
    </div>
  );
}

function ChatMessageBubble({ msg, msgIndex }: { msg: ChatMessage; msgIndex: number }) {
  const [showFullOutput, setShowFullOutput] = useState(false);
  const parsed = useMemo(
    () => msg.role === 'system' ? parseStructuredContent(msg.content) : null,
    [msg.role, msg.content],
  );

  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-lg px-3 py-2 text-xs bg-primary/10 text-ink">
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
    <div className="flex justify-start gap-2">
      {/* Loki avatar */}
      <div className="bg-primary text-white w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0">
        L
      </div>
      <div className="max-w-[80%] rounded-lg px-3 py-2 text-xs bg-hover text-ink border-l-2 border-primary/40">
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

        {/* Reactions (H90) -- only on completed system messages */}
        {msg.role === 'system' && !msg.isStreaming && msg.content && (
          <MessageReactions msgIndex={msgIndex} />
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

const CHAT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const CHAT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function attachmentRefusal(file: File): string | null {
  if (!CHAT_IMAGE_TYPES.has(file.type.toLowerCase())) {
    return 'This attachment was not added. Use a PNG, JPEG, GIF, or WebP image.';
  }
  if (file.size > CHAT_IMAGE_MAX_BYTES) {
    return 'This attachment was not added because it exceeds the 10 MiB limit.';
  }
  return null;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function AIChatPanel({ sessionId, defaultMode, onFilesChanged, services }: AIChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<'quick' | 'standard' | 'max'>(defaultMode || 'quick');
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [pendingImage, setPendingImage] = useState<{ file: File; previewUrl: string } | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachButtonRef = useRef<HTMLButtonElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeTaskRef = useRef<string | null>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const previewUrlsRef = useRef(new Set<string>());

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
      const persisted = messages.slice(-50).map(message => ({ ...message, imageUrl: undefined }));
      sessionStorage.setItem(`chat_${sessionId}`, JSON.stringify(persisted));
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
    const previewUrls = previewUrlsRef.current;
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
      for (const previewUrl of previewUrls) {
        URL.revokeObjectURL(previewUrl);
      }
      previewUrls.clear();
    };
  }, []);

  const releasePreviewUrl = useCallback((previewUrl: string) => {
    if (!previewUrlsRef.current.delete(previewUrl)) return;
    URL.revokeObjectURL(previewUrl);
  }, []);

  // Handle image file selection
  const handleImageFile = useCallback((file: File) => {
    if (sending) return;
    const refusal = attachmentRefusal(file);
    if (refusal) {
      setAttachmentError(refusal);
      return;
    }
    setAttachmentError(null);
    // Revoke previous preview URL
    if (pendingImage?.previewUrl) {
      releasePreviewUrl(pendingImage.previewUrl);
    }
    const previewUrl = URL.createObjectURL(file);
    previewUrlsRef.current.add(previewUrl);
    setPendingImage({ file, previewUrl });
  }, [pendingImage?.previewUrl, releasePreviewUrl, sending]);

  const clearPendingImage = useCallback(() => {
    if (pendingImage?.previewUrl) {
      releasePreviewUrl(pendingImage.previewUrl);
    }
    setPendingImage(null);
    setAttachmentError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    attachButtonRef.current?.focus();
  }, [pendingImage?.previewUrl, releasePreviewUrl]);

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

  // @mention autocomplete state (H89)
  const [mentionVisible, setMentionVisible] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);

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
    setSending(true);
    setAttachmentError(null);

    // Upload image first if present
    let imageUrl: string | undefined;
    let imageName: string | undefined;
    let imageContext = '';

    if (pendingImage) {
      setUploadingImage(true);
      try {
        imageUrl = await readFileAsDataUrl(pendingImage.file);
        const result = await api.chatImageUpload(sessionId, pendingImage.file);
        imageName = result.filename;
        imageContext = `[Attached image: ${result.filename} (id: ${result.image_id})] Make it look like this. `;
      } catch {
        setAttachmentError(
          'The attachment was refused and no message was sent. Use a valid PNG, JPEG, GIF, or WebP image up to 10 MiB.',
        );
        setUploadingImage(false);
        setSending(false);
        return;
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
    if (pendingImage) releasePreviewUrl(pendingImage.previewUrl);
    setPendingImage(null);

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
      className={`flex flex-col h-full relative ${isDragOver ? 'ring-2 ring-primary ring-inset' : ''}`}
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
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3 terminal-scroll">
        {messages.length === 0 && (
          <div className="flex items-start gap-2 py-6 px-2">
            <div className="bg-primary text-white w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0">
              L
            </div>
            <div className="max-w-[80%] rounded-lg px-3 py-2 text-xs bg-hover text-ink border-l-2 border-primary/40">
              <p className="leading-relaxed">
                Hey! I'm Loki, your AI coding companion. Tell me what you want to build and I'll make it happen.
              </p>
            </div>
          </div>
        )}
        {messages.map((msg, i) => (
          <ChatMessageBubble key={i} msg={msg} msgIndex={i} />
        ))}
        {/* Typing indicator (H94) */}
        {streaming && <TypingIndicator />}
      </div>

      {/* Input area */}
      <div className="border-t border-border p-2 flex-shrink-0">
        {/* Status bar when streaming */}
        {streaming && (
          <div className="flex items-center justify-between mb-2 px-1">
            <span className="text-[10px] text-muted font-mono flex items-center gap-1.5">
              Loki is thinking
              <span className="inline-flex items-center gap-0.5">
                <span className="w-1 h-1 rounded-full bg-primary animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1 h-1 rounded-full bg-primary animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1 h-1 rounded-full bg-primary animate-bounce" style={{ animationDelay: '300ms' }} />
              </span>
            </span>
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
          <div
            role="group"
            aria-label="Selected attachment"
            aria-live="polite"
            className="flex items-center gap-2 mb-2 px-1"
          >
            <div className="relative">
              <img
                src={pendingImage.previewUrl}
                alt={`Preview of ${pendingImage.file.name}`}
                className="h-16 max-w-[120px] rounded border border-border object-cover"
              />
              <button
                onClick={clearPendingImage}
                className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-red-500 text-white rounded-full flex items-center justify-center hover:bg-red-600"
                title="Remove image"
                aria-label={`Remove ${pendingImage.file.name}`}
              >
                <X size={10} />
              </button>
            </div>
            <div className="min-w-0 text-[10px] text-muted">
              <p className="truncate max-w-[180px] text-ink" title={pendingImage.file.name}>
                {pendingImage.file.name}
              </p>
              <p>{pendingImage.file.type} · {formatFileSize(pendingImage.file.size)}</p>
            </div>
            {uploadingImage && <span className="text-[10px] text-primary animate-pulse">Uploading...</span>}
          </div>
        )}
        {attachmentError && (
          <p role="alert" className="mb-2 px-1 text-[11px] text-red-400">
            {attachmentError}
          </p>
        )}
        {/* Smart suggestions */}
        {!streaming && (
          <SmartSuggestions
            projectState={messages.length === 0 ? 'empty' : 'idle'}
            hasSession={!!sessionId}
            onSelect={(prompt) => setInput(prompt)}
            className="mb-2"
          />
        )}
        <p id="chat-attachment-guidance" className="mb-1 px-1 text-[10px] text-muted">
          Attach one PNG, JPEG, GIF, or WebP image up to 10 MiB.
        </p>
        {/* Input + send */}
        <div className="flex items-center gap-2">
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleImageFile(file);
              e.target.value = '';
            }}
          />
          {/* Image upload button */}
          <button
            ref={attachButtonRef}
            onClick={() => fileInputRef.current?.click()}
            disabled={sending}
            className="p-1.5 text-muted hover:text-primary rounded transition-colors disabled:opacity-50"
            title="Attach image (or paste/drag-and-drop)"
            aria-label="Attach image"
            aria-describedby="chat-attachment-guidance"
          >
            <ImageIcon size={16} />
          </button>
          <div className="flex-1 relative">
            {/* @mention autocomplete popup (H89) */}
            <MentionAutocomplete
              visible={mentionVisible}
              filter={mentionFilter}
              selectedIndex={mentionIndex}
              onSelect={(mention) => {
                // Replace the @... text with the selected mention
                const atIndex = input.lastIndexOf('@');
                const before = atIndex >= 0 ? input.slice(0, atIndex) : input;
                setInput(before + mention + ' ');
                setMentionVisible(false);
                setMentionIndex(0);
                inputRef.current?.focus();
              }}
              onClose={() => setMentionVisible(false)}
            />
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => {
                const val = e.target.value;
                setInput(val);
                // Detect @ for mention autocomplete
                const lastAt = val.lastIndexOf('@');
                if (lastAt >= 0) {
                  const afterAt = val.slice(lastAt);
                  // Show autocomplete if @ is at end or followed by word chars only
                  if (/^@\w*$/.test(afterAt)) {
                    setMentionVisible(true);
                    setMentionFilter(afterAt);
                    setMentionIndex(0);
                  } else {
                    setMentionVisible(false);
                  }
                } else {
                  setMentionVisible(false);
                }
              }}
              onKeyDown={e => {
                // Handle mention navigation
                if (mentionVisible) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setMentionIndex(i => Math.min(i + 1, MENTION_OPTIONS.length - 1));
                    return;
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setMentionIndex(i => Math.max(i - 1, 0));
                    return;
                  }
                  if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                    e.preventDefault();
                    const filtered = MENTION_OPTIONS.filter(opt =>
                      opt.label.toLowerCase().includes(mentionFilter.toLowerCase()),
                    );
                    if (filtered[mentionIndex]) {
                      const atIndex = input.lastIndexOf('@');
                      const before = atIndex >= 0 ? input.slice(0, atIndex) : input;
                      setInput(before + filtered[mentionIndex].label + ' ');
                      setMentionVisible(false);
                      setMentionIndex(0);
                    }
                    return;
                  }
                  if (e.key === 'Escape') {
                    setMentionVisible(false);
                    return;
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Ask AI to modify your project... (Shift+Enter for new line)"
            rows={1}
            className="w-full px-3 py-1.5 text-xs bg-card border border-border rounded-btn outline-none focus:border-primary transition-colors resize-none"
            style={{ maxHeight: '120px', overflow: 'auto' }}
            disabled={sending}
          />
          </div>
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
