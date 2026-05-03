import { useEffect, useRef, useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  CrossCircledIcon,
  ExclamationTriangleIcon,
  InfoCircledIcon,
} from "@radix-ui/react-icons";
import { useNavigate } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import type { ClaudeSettings } from "@/types";
import "@xterm/xterm/css/xterm.css";
import {
  getOrCreateTerminal,
  attachTerminal,
  detachTerminal,
  ensureWebGL,
  releaseWebGL,
  ptyReadySessions,
  ptyInitLocks,
} from "./terminalPool";

interface PtyDataEvent {
  id: string;
  data: number[];
}

interface PtyExitEvent {
  id: string;
}

type CommandKind = "claude" | "codex";
type DiagnosticSeverity = "error" | "warning" | "info";
type DiagnosticIssueCode = "cli-not-found" | "missing-credentials" | "command-exited" | "command-failed";

interface DiagnosticIssue {
  code: DiagnosticIssueCode;
  severity: DiagnosticSeverity;
  title: string;
  detail?: string;
}

interface CommandDiagnostics {
  command: string;
  commandKind: CommandKind;
  commandLabel: string;
  cliPath?: string;
  description?: string;
  issues: DiagnosticIssue[];
}

const QUICK_EXIT_MS = 1500;

const getCommandKind = (command?: string): CommandKind | null => {
  if (!command) return null;
  const trimmed = command.trim();
  if (!trimmed) return null;
  const firstToken = trimmed.split(/\s+/)[0]?.replace(/^['"]|['"]$/g, "");
  const base = firstToken?.split("/").pop();
  if (base === "claude" || base === "codex") return base;
  return null;
};

const getCommandLabel = (kind: CommandKind) => (kind === "claude" ? "Claude Code" : "Codex");

const getEnvFromSettings = (settings: ClaudeSettings | null | undefined): Record<string, string> => {
  const raw = settings?.raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const envValue = (raw as Record<string, unknown>).env;
  if (!envValue || typeof envValue !== "object" || Array.isArray(envValue)) return {};
  return Object.fromEntries(
    Object.entries(envValue as Record<string, unknown>).map(([key, value]) => [key, String(value ?? "").trim()])
  );
};

const isTruthyEnv = (value: string) => {
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
};

async function runCommandDiagnostics(command: string, cwd: string): Promise<CommandDiagnostics | null> {
  const commandKind = getCommandKind(command);
  if (!commandKind) return null;

  const commandLabel = getCommandLabel(commandKind);
  const issues: DiagnosticIssue[] = [];
  let cliPath: string | undefined;

  try {
    const output = await invoke<string>("exec_shell_command", {
      command: `command -v ${commandKind} 2>/dev/null`,
      cwd,
    });
    const trimmed = output.trim();
    cliPath = trimmed || undefined;
    if (!cliPath) {
      issues.push({
        code: "cli-not-found",
        severity: "error",
        title: `${commandLabel} CLI not found in PATH`,
        detail: `Install ${commandKind} and ensure your shell PATH includes it.`,
      });
    }
  } catch {
    issues.push({
      code: "cli-not-found",
      severity: "error",
      title: `${commandLabel} CLI not found in PATH`,
      detail: `Install ${commandKind} and ensure your shell PATH includes it.`,
    });
  }

  if (commandKind === "claude") {
    try {
      const settings = await invoke<ClaudeSettings>("get_settings");
      const env = getEnvFromSettings(settings);
      const hasOauth = isTruthyEnv(env.CLAUDE_CODE_USE_OAUTH || "");
      const hasAuthToken = Boolean(env.ANTHROPIC_AUTH_TOKEN);
      const hasApiKey = Boolean(env.ANTHROPIC_API_KEY);
      const hasProxyKey = Boolean(
        env.ZENMUX_API_KEY ||
        env.MODELGATE_API_KEY ||
        env.QINIU_API_KEY ||
        env.SILICONFLOW_API_KEY
      );

      if (!hasOauth && !hasAuthToken && !hasApiKey && !hasProxyKey) {
        issues.push({
          code: "missing-credentials",
          severity: "warning",
          title: "Claude credentials not configured",
          detail: "Set ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY or enable OAuth (CLAUDE_CODE_USE_OAUTH=1). In CN, configure a proxy in LLM Providers.",
        });
      }
    } catch {
      issues.push({
        code: "missing-credentials",
        severity: "warning",
        title: "Unable to read Claude settings",
        detail: "Check ~/.claude/settings.json and ensure Lovcode has access to it.",
      });
    }
  }

  if (issues.length === 0) return null;

  return {
    command,
    commandKind,
    commandLabel,
    cliPath,
    description: "Lovcode couldn't launch the CLI session. Review the issues below.",
    issues,
  };
}

export interface TerminalPaneProps {
  /** Unique identifier for this terminal session */
  ptyId: string;
  /** Working directory for the shell */
  cwd: string;
  /** Optional command to run instead of shell */
  command?: string;
  /** Text to send to terminal after it's ready (for interactive input) */
  initialInput?: string;
  /** Whether this terminal is visible (active tab) - controls WebGL loading */
  visible?: boolean;
  /** Auto focus terminal when ready */
  autoFocus?: boolean;
  /** Callback when terminal is ready */
  onReady?: () => void;
  /** Callback when terminal session ends */
  onExit?: () => void;
  /** Callback when title changes */
  onTitleChange?: (title: string) => void;
  /** Custom class name */
  className?: string;
}

export function TerminalPane({
  ptyId,
  cwd,
  command,
  initialInput,
  visible = true,
  autoFocus = false,
  onReady,
  onExit,
  onTitleChange,
  className = "",
}: TerminalPaneProps) {
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const cwdRef = useRef(cwd);
  const commandRef = useRef(command);
  const initialInputRef = useRef(initialInput);
  const autoFocusRef = useRef(autoFocus);
  const onReadyRef = useRef(onReady);
  const onExitRef = useRef(onExit);
  const onTitleChangeRef = useRef(onTitleChange);
  const preflightRef = useRef<CommandDiagnostics | null>(null);
  const commandStartRef = useRef<number | null>(null);
  const hadOutputRef = useRef(false);
  const commandExitHandledRef = useRef(false);
  const diagnosticShownRef = useRef(false);
  const [diagnostic, setDiagnostic] = useState<CommandDiagnostics | null>(null);
  const [diagnosticOpen, setDiagnosticOpen] = useState(false);

  useEffect(() => { cwdRef.current = cwd; }, [cwd]);
  useEffect(() => { commandRef.current = command; }, [command]);
  useEffect(() => { initialInputRef.current = initialInput; }, [initialInput]);
  useEffect(() => { autoFocusRef.current = autoFocus; }, [autoFocus]);
  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);
  useEffect(() => { onExitRef.current = onExit; }, [onExit]);
  useEffect(() => { onTitleChangeRef.current = onTitleChange; }, [onTitleChange]);
  useEffect(() => {
    diagnosticShownRef.current = false;
    preflightRef.current = null;
    commandStartRef.current = null;
    hadOutputRef.current = false;
    commandExitHandledRef.current = false;
    setDiagnostic(null);
    setDiagnosticOpen(false);
  }, [ptyId]);

  const openDiagnostic = useCallback((diag: CommandDiagnostics) => {
    if (diagnosticShownRef.current) return;
    diagnosticShownRef.current = true;
    setDiagnostic(diag);
    setDiagnosticOpen(true);
  }, []);

  // Load/unload WebGL based on visibility to prevent context exhaustion
  useEffect(() => {
    if (visible) {
      ensureWebGL(ptyId);
    } else {
      releaseWebGL(ptyId);
    }
  }, [visible, ptyId]);

  // Initialize terminal and PTY
  useEffect(() => {
    if (!containerRef.current) return;
    const sessionId = ptyId;

    // Get or create pooled terminal (preserves history on remount)
    const pooled = getOrCreateTerminal(sessionId);
    const { term, fitAddon } = pooled;

    // Attach to this component's container
    containerRef.current.appendChild(pooled.container);

    // Fit after attach
    requestAnimationFrame(() => {
      fitAddon.fit();
    });

    // IME Fix: Handle direct non-ASCII input (Shift+punctuation) to bypass xterm's buggy CompositionHelper
    // Composition input (pinyin) should go through xterm normally
    // See: https://github.com/xtermjs/xterm.js/issues/3070
    const textarea = pooled.container.querySelector("textarea") as HTMLTextAreaElement;
    const pendingDirectInputs: Array<{ data: string; asciiFallback?: string; ts: number }> = [];
    const DIRECT_INPUT_TIMEOUT_MS = 120;
    const asciiSymbolRegex = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/;

    const getAsciiFallback = (data: string): string | null => {
      if (data.length !== 1) return null;
      const code = data.charCodeAt(0);
      if (code >= 0xff01 && code <= 0xff5e) {
        return String.fromCharCode(code - 0xfee0);
      }
      return null;
    };

    const enqueueDirectInput = (data: string) => {
      pendingDirectInputs.push({
        data,
        asciiFallback: getAsciiFallback(data) ?? undefined,
        ts: Date.now(),
      });
      if (pendingDirectInputs.length > 5) pendingDirectInputs.shift();
    };

    const shouldSkipXtermInput = (data: string) => {
      if (pendingDirectInputs.length === 0) return false;
      const now = Date.now();
      while (pendingDirectInputs.length > 0 && now - pendingDirectInputs[0].ts > DIRECT_INPUT_TIMEOUT_MS) {
        pendingDirectInputs.shift();
      }
      const pending = pendingDirectInputs[0];
      if (!pending) return false;
      if (data === pending.data || (pending.asciiFallback && data === pending.asciiFallback)) {
        pendingDirectInputs.shift();
        return true;
      }
      return false;
    };

    if (textarea) {
      // Use beforeinput to intercept BEFORE the character enters textarea
      // inputType 'insertText' is for direct input, 'insertCompositionText' is for IME composition
      textarea.addEventListener("beforeinput", (e) => {
        const ie = e as InputEvent;

        const isInsertText = ie.inputType === "insertText";
        const isInsertComposition = ie.inputType === "insertCompositionText";
        if ((!isInsertText && !isInsertComposition) || !ie.data) return;
        const isNonAscii = /[^\x00-\x7f]/.test(ie.data);
        const isAsciiSymbol = asciiSymbolRegex.test(ie.data);
        const shouldHandleNonAscii = isNonAscii && isInsertText;
        const shouldHandleAsciiSymbol = isAsciiSymbol && (isInsertText || isInsertComposition);
        if (!shouldHandleNonAscii && !shouldHandleAsciiSymbol) return;

        e.preventDefault(); // Prevent xterm from seeing it at all
        enqueueDirectInput(ie.data);
        // Send directly to PTY
        if (ptyReadySessions.has(sessionId)) {
          const encoder = new TextEncoder();
          invoke("pty_write", { id: sessionId, data: Array.from(encoder.encode(ie.data)) });
        }
      }, { capture: true });
    }

    // Track mount state and session state
    const mountState = { isMounted: true };
    const sessionState = { exited: false, restarting: false };

    // Initialize PTY session
    const initPty = async () => {
      const pendingInit = ptyInitLocks.get(sessionId);
      if (pendingInit) {
        await pendingInit;
      }

      if (!mountState.isMounted) return;

      let resolveLock: () => void;
      const lockPromise = new Promise<void>((resolve) => {
        resolveLock = resolve;
      });
      ptyInitLocks.set(sessionId, lockPromise);

      try {
        const exists = await invoke<boolean>("pty_exists", { id: sessionId });

        if (!mountState.isMounted) return;

        const isNewPty = !exists;
        if (isNewPty) {
          const commandText = commandRef.current?.trim();
          if (commandText) {
            commandStartRef.current = Date.now();
            hadOutputRef.current = false;
            commandExitHandledRef.current = false;
            const diagnostics = await runCommandDiagnostics(commandText, cwdRef.current);
            if (!mountState.isMounted) return;
            if (diagnostics) {
              preflightRef.current = diagnostics;
              openDiagnostic(diagnostics);
            }
          }
          await invoke("pty_create", { id: sessionId, cwd: cwdRef.current, command: commandRef.current });
        }

        // Replay scrollback buffer (works for both page refresh and app restart)
        const scrollback = await invoke<number[]>("pty_scrollback", { id: sessionId });
        if (scrollback.length > 0 && mountState.isMounted) {
          const bytes = new Uint8Array(scrollback);
          const text = new TextDecoder().decode(bytes);
          term.write(text);
        }

        ptyReadySessions.add(sessionId);

        if (!mountState.isMounted) return;

        // Ensure terminal is properly sized before sending resize to PTY
        // This must happen AFTER DOM is ready, so use double rAF
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              fitAddon.fit();
              resolve();
            });
          });
        });

        // Only send resize if dimensions are valid (container must be visible)
        const cols = term.cols;
        const rows = term.rows;
        if (cols >= 10 && rows >= 2) {
          await invoke("pty_resize", {
            id: sessionId,
            cols,
            rows,
          }).catch(() => {});
        }

        // Focus terminal when ready
        if (autoFocusRef.current) {
          // For new PTY, always focus (user explicitly created it)
          // For restored PTY, don't steal focus from active input
          if (isNewPty) {
            term.focus();
          } else {
            const active = document.activeElement;
            if (active?.tagName !== 'INPUT' && active?.tagName !== 'TEXTAREA') {
              term.focus();
            }
          }
        }
        onReadyRef.current?.();
      } catch (err) {
        if (mountState.isMounted) {
          const commandText = commandRef.current?.trim();
          const commandKind = getCommandKind(commandText);
          if (commandText && commandKind) {
            openDiagnostic({
              command: commandText,
              commandKind,
              commandLabel: getCommandLabel(commandKind),
              description: "Lovcode couldn't create the CLI session.",
              issues: [{
                code: "command-failed",
                severity: "error",
                title: "Failed to start the CLI process",
                detail: String(err),
              }],
            });
          }
          console.error("Failed to initialize PTY:", err);
          term.writeln(`\r\n\x1b[31mFailed to create terminal: ${err}\x1b[0m`);
        }
      } finally {
        ptyInitLocks.delete(sessionId);
        resolveLock!();
      }
    };

    // macOS keyboard shortcuts - directly write to PTY for better compatibility
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      if (!ptyReadySessions.has(sessionId)) return true;

      // Shift+Enter: bracketed paste with U+2028 (Line Separator)
      if (event.key === 'Enter' && event.shiftKey) {
        invoke("pty_write", { id: sessionId, data: [0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e, 0xe2, 0x80, 0xa8, 0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e] });
        return false;
      }

      // Cmd+Left: Home (line start) - try multiple sequences
      if (event.key === 'ArrowLeft' && event.metaKey && !event.altKey) {
        // Send Ctrl+A (0x01) - emacs style line start
        invoke("pty_write", { id: sessionId, data: [0x01] });
        return false;
      }

      // Cmd+Right: End (line end)
      if (event.key === 'ArrowRight' && event.metaKey && !event.altKey) {
        // Send Ctrl+E (0x05) - emacs style line end
        invoke("pty_write", { id: sessionId, data: [0x05] });
        return false;
      }

      // Cmd+Backspace: Delete to line start
      if (event.key === 'Backspace' && event.metaKey && !event.altKey) {
        // Send Ctrl+U (0x15) - kill line backward
        invoke("pty_write", { id: sessionId, data: [0x15] });
        return false;
      }

      // Option+Left: Word backward
      if (event.key === 'ArrowLeft' && event.altKey && !event.metaKey) {
        // Send ESC b (Alt+b) - backward word
        invoke("pty_write", { id: sessionId, data: [0x1b, 0x62] });
        return false;
      }

      // Option+Right: Word forward
      if (event.key === 'ArrowRight' && event.altKey && !event.metaKey) {
        // Send ESC f (Alt+f) - forward word
        invoke("pty_write", { id: sessionId, data: [0x1b, 0x66] });
        return false;
      }

      // Option+Backspace: Delete word backward
      if (event.key === 'Backspace' && event.altKey && !event.metaKey) {
        // Send Ctrl+W (0x17) - kill word backward
        invoke("pty_write", { id: sessionId, data: [0x17] });
        return false;
      }

      return true;
    });

    // Fall back to default shell after command exits (like normal terminal behavior)
    const fallbackToShell = async () => {
      if (sessionState.restarting) return;
      sessionState.restarting = true;

      try {
        // Create new PTY session with default shell (no command = interactive shell)
        await invoke("pty_create", { id: sessionId, cwd: cwdRef.current });
        ptyReadySessions.add(sessionId);
        sessionState.exited = false;

        // Send resize
        const cols = term.cols;
        const rows = term.rows;
        if (cols >= 10 && rows >= 2) {
          await invoke("pty_resize", { id: sessionId, cols, rows }).catch(() => {});
        }
      } catch (err) {
        console.error("Failed to start shell:", err);
        term.writeln(`\r\n\x1b[31mFailed to start shell: ${err}\x1b[0m`);
      } finally {
        sessionState.restarting = false;
      }
    };

    // Handle user input
    const onDataDisposable = term.onData((data) => {
      if (!ptyReadySessions.has(sessionId)) return;

      if (shouldSkipXtermInput(data)) return;

      const encoder = new TextEncoder();
      const bytes = Array.from(encoder.encode(data));
      invoke("pty_write", { id: sessionId, data: bytes }).catch(console.error);
    });

    // Handle title changes
    const onTitleDisposable = term.onTitleChange((title) => {
      onTitleChangeRef.current?.(title);
    });

    // Listen for PTY data events
    // Use streaming decoder to handle multi-byte UTF-8 chars split across events
    const decoder = new TextDecoder("utf-8", { fatal: false });

    // Batch PTY data to reduce render frequency and prevent flicker
    // When data arrives faster than frame rate, multiple writes cause visual jitter
    let pendingBytes: number[] = [];
    let writeFrameId: number | null = null;
    let writeCount = 0;
    let batchCount = 0;

    const flushPendingData = () => {
      writeFrameId = null;
      if (pendingBytes.length === 0 || !mountState.isMounted) return;

      writeCount++;
      const bytes = new Uint8Array(pendingBytes);
      pendingBytes = [];
      const text = decoder.decode(bytes, { stream: true });

      // Lock scroll position during write to prevent flicker from intermediate states
      const viewport = pooled.container.querySelector('.xterm-viewport') as HTMLElement;
      if (viewport) {
        const scrollTop = viewport.scrollTop;
        const onScroll = () => { viewport.scrollTop = scrollTop; };
        viewport.addEventListener('scroll', onScroll);
        term.write(text, () => {
          // Remove scroll lock after write completes
          viewport.removeEventListener('scroll', onScroll);
        });
      } else {
        term.write(text);
      }
    };

    // Track if initial input has been sent (send on first pty-data = shell prompt ready)
    let initialInputSent = false;

    const unlistenData = listen<PtyDataEvent>("pty-data", (event) => {
      if (event.payload.id === sessionId && mountState.isMounted) {
        if (event.payload.data.length > 0) {
          hadOutputRef.current = true;
        }
        // Send initial input on first data received (shell prompt is ready)
        if (!initialInputSent && initialInputRef.current) {
          initialInputSent = true;
          const input = initialInputRef.current;
          initialInputRef.current = undefined;
          const encoder = new TextEncoder();
          const bytes = Array.from(encoder.encode(input));
          invoke("pty_write", { id: sessionId, data: bytes }).catch(console.error);
          // Focus terminal after sending initial input
          term.focus();
        }

        // Accumulate raw bytes (preserves UTF-8 boundary handling)
        pendingBytes.push(...event.payload.data);
        batchCount++;

        // Schedule single write per frame
        if (writeFrameId === null) {
          writeFrameId = requestAnimationFrame(flushPendingData);
          batchCount = 1; // Reset batch count for this frame
        }
      }
    });

    // Listen for PTY exit events
    const unlistenExit = listen<PtyExitEvent>("pty-exit", (event) => {
      if (event.payload.id === sessionId && mountState.isMounted) {
        // Mark session as not ready to prevent further write attempts
        ptyReadySessions.delete(sessionId);
        sessionState.exited = true;

        // For command sessions (claude/codex), fall back to shell automatically
        if (commandRef.current) {
          if (!commandExitHandledRef.current) {
            const commandText = commandRef.current.trim();
            const commandKind = getCommandKind(commandText);
            if (commandKind) {
              const now = Date.now();
              const startedAt = commandStartRef.current ?? now;
              const exitedQuickly = now - startedAt < QUICK_EXIT_MS;
              const noOutput = !hadOutputRef.current;
              const preflight = preflightRef.current;
              if (!diagnosticShownRef.current && (preflight || (exitedQuickly && noOutput))) {
                const base = preflight ?? {
                  command: commandText,
                  commandKind,
                  commandLabel: getCommandLabel(commandKind),
                  issues: [],
                };
                const issues = [...base.issues];
                if (exitedQuickly && noOutput) {
                  issues.push({
                    code: "command-exited",
                    severity: "error",
                    title: `${base.commandLabel} exited immediately`,
                    detail: "The CLI process ended before producing output. Check login, proxy, or network settings.",
                  });
                }
                openDiagnostic({ ...base, issues });
              }
            }
            commandExitHandledRef.current = true;
          }
          fallbackToShell();
        } else {
          // Plain shell session ended - close the tab
          onExitRef.current?.();
        }
      }
    });

    initPty();

    // Cleanup - detach but don't dispose (preserves instance for reattachment)
    return () => {
      mountState.isMounted = false;
      if (writeFrameId !== null) {
        cancelAnimationFrame(writeFrameId);
      }
      pendingBytes = [];
      onDataDisposable.dispose();
      onTitleDisposable.dispose();
      unlistenData.then((fn) => fn());
      unlistenExit.then((fn) => fn());

      // Just detach from DOM, keep terminal alive in pool
      detachTerminal(sessionId);
    };
  }, [ptyId]); // Only re-run when ptyId changes (reload), not cwd/command

  // Handle resize
  const handleResize = useCallback(() => {
    const pooled = attachTerminal(ptyId, containerRef.current!);
    if (!pooled) return;

    pooled.fitAddon.fit();
    const newCols = pooled.term.cols;
    const newRows = pooled.term.rows;

    if (ptyReadySessions.has(ptyId)) {
      invoke("pty_resize", { id: ptyId, cols: newCols, rows: newRows }).catch(console.error);
    }
  }, [ptyId]);

  // Observe container size changes (debounced to avoid SIGWINCH spam)
  useEffect(() => {
    if (!containerRef.current) return;

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(handleResize, 100);
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeObserver.disconnect();
    };
  }, [handleResize]);

  // Auto-focus when autoFocus prop becomes true
  useEffect(() => {
    if (!autoFocus) return;
    if (!ptyReadySessions.has(ptyId)) return;

    const pooled = attachTerminal(ptyId, containerRef.current!);
    if (pooled) {
      // Use double rAF to ensure DOM is fully painted before focus
      requestAnimationFrame(() => {
        pooled.fitAddon.fit();
        requestAnimationFrame(() => {
          // Don't steal focus from input/textarea
          const active = document.activeElement;
          if (active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA') return;
          pooled.term.focus();
        });
      });
    }
  }, [autoFocus, ptyId]);

  // Focus terminal on click
  const handleClick = useCallback(() => {
    const pooled = attachTerminal(ptyId, containerRef.current!);
    pooled?.term.focus();
  }, [ptyId]);

  return (
    <>
      <div
        ref={containerRef}
        className={`w-full h-full bg-[#1a1a1a] ${className}`}
        onClick={handleClick}
      />
      <Dialog open={diagnosticOpen} onOpenChange={setDiagnosticOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{diagnostic ? `Unable to start ${diagnostic.commandLabel}` : "Unable to start CLI"}</DialogTitle>
            <DialogDescription>
              {diagnostic?.description ?? "Lovcode couldn't launch the CLI session. Review the issues below."}
            </DialogDescription>
          </DialogHeader>
          {diagnostic && (
            <div className="space-y-3">
              <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                <div className="font-medium text-ink">Command</div>
                <code className="break-all">{diagnostic.command}</code>
                {diagnostic.cliPath && (
                  <div className="mt-2">
                    <div className="font-medium text-ink">Detected CLI</div>
                    <code className="break-all">{diagnostic.cliPath}</code>
                  </div>
                )}
              </div>
              <div className="space-y-2">
                {diagnostic.issues.map((issue, index) => {
                  const icon = issue.severity === "error"
                    ? <CrossCircledIcon className="w-4 h-4 text-red-500" />
                    : issue.severity === "warning"
                    ? <ExclamationTriangleIcon className="w-4 h-4 text-amber-500" />
                    : <InfoCircledIcon className="w-4 h-4 text-blue-500" />;
                  return (
                    <div key={`${issue.code}-${index}`} className="flex items-start gap-2">
                      <div className="mt-0.5">{icon}</div>
                      <div className="space-y-0.5">
                        <div className="text-sm font-medium text-ink">{issue.title}</div>
                        {issue.detail && (
                          <div className="text-xs text-muted-foreground">{issue.detail}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <DialogFooter>
            {diagnostic?.commandKind === "claude" && diagnostic.issues.some((issue) => issue.code === "cli-not-found") && (
              <Button
                variant="outline"
                onClick={() => {
                  setDiagnosticOpen(false);
                  navigate("/settings/version");
                }}
              >
                Open CC Version
              </Button>
            )}
            {diagnostic?.commandKind === "claude" && !diagnostic.issues.some((issue) => issue.code === "cli-not-found") && (
              <Button
                variant="outline"
                onClick={() => {
                  setDiagnosticOpen(false);
                  navigate("/settings/maas");
                }}
              >
                Open MaaS Registry
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => {
                setDiagnosticOpen(false);
                navigate("/settings/env");
              }}
            >
              Open Environment
            </Button>
            <Button onClick={() => setDiagnosticOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
