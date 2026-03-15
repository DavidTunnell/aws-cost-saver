import { useState, useEffect, useRef } from "react";
import { getSolutions, executeSolutions, type SolutionsData } from "../api";

interface SolutionsModalProps {
  category: string;
  action: string;
  instanceId: string;
  instanceType: string;
  metadata: Record<string, string>;
  accountId: number;
  cachedSolutions: SolutionsData | null;
  onSolutionsLoaded: (data: SolutionsData) => void;
  onClose: () => void;
}

// ─── Markdown helpers ─────────────────────────────────────────────────────

// Extract code blocks from markdown, return { explanatory text, code content }
function extractCodeBlocks(markdown: string): { text: string; code: string } {
  const lines = markdown.split("\n");
  const textLines: string[] = [];
  const codeLines: string[] = [];
  let inCode = false;

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeLines.push(line);
    } else {
      textLines.push(line);
    }
  }

  return {
    text: textLines.join("\n").trim(),
    code: codeLines.join("\n").trim(),
  };
}

// Simple markdown-to-JSX renderer for code blocks, headers, bold, lists
function renderMarkdown(text: string) {
  const lines = text.split("\n");
  const elements: JSX.Element[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.trim().startsWith("```")) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      const codeContent = codeLines.join("\n");
      elements.push(
        <div key={key++} className="relative group my-2">
          <pre className="bg-gray-900 dark:bg-gray-950 text-green-400 text-xs font-mono rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">
            {codeContent}
          </pre>
          <button
            onClick={() => navigator.clipboard.writeText(codeContent)}
            className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 px-2 py-1 rounded"
          >
            Copy
          </button>
        </div>
      );
      continue;
    }

    // Headers
    if (line.startsWith("### ")) {
      elements.push(
        <h4 key={key++} className="text-sm font-semibold text-gray-800 dark:text-gray-200 mt-3 mb-1">
          {line.slice(4)}
        </h4>
      );
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      elements.push(
        <h3 key={key++} className="text-base font-semibold text-gray-800 dark:text-gray-200 mt-3 mb-1">
          {line.slice(3)}
        </h3>
      );
      i++;
      continue;
    }

    // Empty line
    if (line.trim() === "") {
      elements.push(<div key={key++} className="h-2" />);
      i++;
      continue;
    }

    // Numbered or bulleted list items
    if (/^\d+\.\s/.test(line) || /^[-*]\s/.test(line)) {
      elements.push(
        <p key={key++} className="text-sm text-gray-700 dark:text-gray-300 ml-2 my-0.5">
          {renderInline(line)}
        </p>
      );
      i++;
      continue;
    }

    // Regular paragraph
    elements.push(
      <p key={key++} className="text-sm text-gray-700 dark:text-gray-300 my-0.5">
        {renderInline(line)}
      </p>
    );
    i++;
  }

  return <>{elements}</>;
}

// Render inline markdown: **bold**, `code`
function renderInline(text: string): (string | JSX.Element)[] {
  const parts: (string | JSX.Element)[] = [];
  const regex = /(\*\*.*?\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith("**") && token.endsWith("**")) {
      parts.push(
        <strong key={key++} className="font-semibold text-gray-900 dark:text-gray-100">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith("`") && token.endsWith("`")) {
      parts.push(
        <code key={key++} className="bg-gray-100 dark:bg-gray-700 text-pink-600 dark:text-pink-400 px-1 py-0.5 rounded text-xs font-mono">
          {token.slice(1, -1)}
        </code>
      );
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

// ─── Main Component ───────────────────────────────────────────────────────

export default function SolutionsModal({
  category,
  action,
  instanceId,
  instanceType,
  metadata,
  accountId,
  cachedSolutions,
  onSolutionsLoaded,
  onClose,
}: SolutionsModalProps) {
  const [tab, setTab] = useState<"console" | "cli">("console");
  const [loading, setLoading] = useState(!cachedSolutions);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<SolutionsData | null>(cachedSolutions);
  const backdropRef = useRef<HTMLDivElement>(null);

  // CLI editing state
  const [editableCli, setEditableCli] = useState(() => {
    if (cachedSolutions) return extractCodeBlocks(cachedSolutions.cli).code;
    return "";
  });
  const [cliExplanation, setCliExplanation] = useState(() => {
    if (cachedSolutions) return extractCodeBlocks(cachedSolutions.cli).text;
    return "";
  });
  const [isEditing, setIsEditing] = useState(false);

  // Execution state
  const [showConfirm, setShowConfirm] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [execOutput, setExecOutput] = useState<string | null>(null);
  const [execSuccess, setExecSuccess] = useState<boolean | null>(null);

  const fetchSolutions = (cancelled = { current: false }) => {
    setLoading(true);
    setError(null);

    getSolutions({ category, action, instanceId, instanceType, metadata })
      .then((result) => {
        if (!cancelled.current) {
          setData(result);
          onSolutionsLoaded(result);
          const { text, code } = extractCodeBlocks(result.cli);
          setCliExplanation(text);
          setEditableCli(code);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled.current) {
          setError(err.message);
          setLoading(false);
        }
      });
  };

  useEffect(() => {
    // Skip fetch if we have cached data
    if (cachedSolutions) return;

    const cancelled = { current: false };
    fetchSolutions(cancelled);

    return () => {
      cancelled.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close on Escape (but not if confirm dialog is open)
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showConfirm) {
          setShowConfirm(false);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, showConfirm]);

  // Close on backdrop click
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === backdropRef.current && !showConfirm) onClose();
  };

  const handleRunCommands = async () => {
    setShowConfirm(false);
    setExecuting(true);
    setExecOutput(null);
    setExecSuccess(null);

    try {
      const result = await executeSolutions(editableCli, accountId);
      setExecOutput(result.output);
      setExecSuccess(result.success);
    } catch (err: any) {
      setExecOutput(`Failed to execute: ${err.message}`);
      setExecSuccess(false);
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
    >
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex-1 min-w-0">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Solution Steps
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">
              {instanceId} · {category}
            </p>
          </div>
          {cachedSolutions && (
            <button
              onClick={() => fetchSolutions()}
              disabled={loading}
              className="ml-3 text-xs font-medium px-2.5 py-1 rounded border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors disabled:opacity-50"
            >
              {loading ? "Regenerating..." : "Regenerate"}
            </button>
          )}
          <button
            onClick={onClose}
            className="ml-3 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-200 dark:border-gray-700 px-5">
          <button
            onClick={() => setTab("console")}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === "console"
                ? "border-indigo-500 text-indigo-600 dark:text-indigo-400"
                : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
            }`}
          >
            Console Instructions
          </button>
          <button
            onClick={() => setTab("cli")}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === "cli"
                ? "border-indigo-500 text-indigo-600 dark:text-indigo-400"
                : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
            }`}
          >
            CLI Commands
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center h-48">
              <div className="flex items-center gap-3 text-gray-500 dark:text-gray-400">
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Generating solution steps...
              </div>
            </div>
          ) : error ? (
            <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 rounded-lg p-4 text-sm">
              {error}
            </div>
          ) : data ? (
            tab === "console" ? (
              <div>{renderMarkdown(data.console)}</div>
            ) : (
              /* CLI tab with editable commands */
              <div className="space-y-3">
                {/* Explanatory text (read-only) */}
                {cliExplanation && (
                  <div>{renderMarkdown(cliExplanation)}</div>
                )}

                {/* Editable CLI textarea */}
                <div className="relative">
                  <textarea
                    value={editableCli}
                    onChange={(e) => setEditableCli(e.target.value)}
                    readOnly={!isEditing}
                    className={`w-full min-h-[350px] bg-gray-900 dark:bg-gray-950 text-green-400 text-xs font-mono rounded-lg p-3 resize-y focus:outline-none transition-all ${
                      isEditing
                        ? "ring-2 ring-indigo-500 border border-indigo-500"
                        : "border border-gray-700"
                    }`}
                    spellCheck={false}
                  />
                  {!isEditing && (
                    <button
                      onClick={() => navigator.clipboard.writeText(editableCli)}
                      className="absolute top-2 right-2 text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 px-2 py-1 rounded opacity-70 hover:opacity-100 transition-opacity"
                    >
                      Copy
                    </button>
                  )}
                </div>

                {/* Edit/Save + Run buttons */}
                <div className="flex items-center gap-2">
                  {isEditing ? (
                    <button
                      onClick={() => setIsEditing(false)}
                      className="text-xs font-medium px-3 py-1.5 rounded border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 transition-colors"
                    >
                      Save
                    </button>
                  ) : (
                    <button
                      onClick={() => setIsEditing(true)}
                      className="text-xs font-medium px-3 py-1.5 rounded border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors"
                    >
                      Edit
                    </button>
                  )}
                  <button
                    onClick={() => setShowConfirm(true)}
                    disabled={executing || !editableCli.trim()}
                    className="text-xs font-medium px-3 py-1.5 rounded border border-orange-200 dark:border-orange-800 bg-orange-50 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300 hover:bg-orange-100 dark:hover:bg-orange-900/60 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {executing ? (
                      <span className="flex items-center gap-1.5">
                        <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        Running...
                      </span>
                    ) : (
                      "Run Commands"
                    )}
                  </button>
                </div>

                {/* Confirmation dialog */}
                {showConfirm && (
                  <div className="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg p-4">
                    <div className="flex items-start gap-3">
                      <svg className="w-5 h-5 text-orange-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                      </svg>
                      <div className="flex-1">
                        <p className="text-sm font-medium text-orange-800 dark:text-orange-200">
                          Are you sure you want to execute these AWS CLI commands?
                        </p>
                        <p className="text-xs text-orange-700 dark:text-orange-300 mt-1">
                          This will make changes to your AWS account. Review the commands carefully before proceeding.
                        </p>
                        <div className="flex items-center gap-2 mt-3">
                          <button
                            onClick={handleRunCommands}
                            className="text-xs font-medium px-3 py-1.5 rounded bg-orange-600 text-white hover:bg-orange-700 transition-colors"
                          >
                            Yes, Run
                          </button>
                          <button
                            onClick={() => setShowConfirm(false)}
                            className="text-xs font-medium px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Execution output */}
                {execOutput !== null && (
                  <div className="mt-2">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
                        Execution Output
                      </span>
                      {execSuccess !== null && (
                        <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                          execSuccess
                            ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
                            : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
                        }`}>
                          {execSuccess ? "Success" : "Errors"}
                        </span>
                      )}
                    </div>
                    <pre className="bg-gray-900 dark:bg-gray-950 text-gray-300 text-xs font-mono rounded-lg p-3 overflow-x-auto whitespace-pre-wrap max-h-[200px] overflow-y-auto">
                      {execOutput}
                    </pre>
                  </div>
                )}
              </div>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}
