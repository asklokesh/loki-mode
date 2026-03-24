import { useState, useMemo } from 'react';
import { Info, Clock, FileCode2, GitBranch, Lightbulb, ChevronDown, ChevronUp, Cpu, Link2 } from 'lucide-react';

interface FileInsightsProps {
  /** File path being inspected */
  filePath: string;
  /** File content for analysis */
  content: string;
  /** Last modified timestamp (ISO string) */
  lastModified?: string;
  /** Whether the file was AI-generated */
  isAiGenerated?: boolean;
  /** File size in bytes */
  fileSize?: number;
  /** CSS class names */
  className?: string;
}

interface InsightData {
  complexity: { score: number; label: string; description: string };
  imports: string[];
  exports: string[];
  lineCount: number;
  suggestions: string[];
  language: string;
  functionCount: number;
}

function getLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TypeScript (React)', js: 'JavaScript', jsx: 'JavaScript (React)',
    py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust', java: 'Java',
    css: 'CSS', scss: 'SCSS', html: 'HTML', json: 'JSON', yaml: 'YAML', yml: 'YAML',
    md: 'Markdown', sh: 'Shell', bash: 'Shell', zsh: 'Shell',
    sql: 'SQL', graphql: 'GraphQL', proto: 'Protocol Buffers',
    dockerfile: 'Dockerfile', toml: 'TOML',
  };
  return map[ext] || ext.toUpperCase();
}

function analyzeFile(path: string, content: string): InsightData {
  const lines = content.split('\n');
  const lineCount = lines.length;
  const language = getLanguage(path);

  // Extract imports
  const imports: string[] = [];
  const importPatterns = [
    /import\s+.*?\s+from\s+['"](.+?)['"]/g,       // ES6 import
    /import\s+['"](.+?)['"]/g,                      // side-effect import
    /require\(['"](.+?)['"]\)/g,                     // CommonJS require
    /from\s+(\S+)\s+import/g,                        // Python import
  ];
  for (const line of lines) {
    for (const pattern of importPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(line)) !== null) {
        imports.push(match[1]);
      }
    }
  }

  // Extract exports
  const exports: string[] = [];
  const exportPattern = /export\s+(?:default\s+)?(?:function|const|class|interface|type|enum)\s+(\w+)/g;
  for (const line of lines) {
    exportPattern.lastIndex = 0;
    let match;
    while ((match = exportPattern.exec(line)) !== null) {
      exports.push(match[1]);
    }
  }

  // Count functions
  const functionPatterns = [
    /(?:function|const|let|var)\s+\w+\s*(?:=\s*)?(?:\(|=>)/g,
    /def\s+\w+/g,
    /func\s+\w+/g,
    /fn\s+\w+/g,
  ];
  let functionCount = 0;
  for (const line of lines) {
    for (const pattern of functionPatterns) {
      pattern.lastIndex = 0;
      const matches = line.match(pattern);
      if (matches) functionCount += matches.length;
    }
  }

  // Complexity heuristic
  // Based on: line count, nesting depth, function count, import count
  let complexityScore = 0;

  // Lines: 0-50 simple, 50-200 moderate, 200+ complex
  if (lineCount > 500) complexityScore += 40;
  else if (lineCount > 200) complexityScore += 25;
  else if (lineCount > 100) complexityScore += 15;
  else complexityScore += 5;

  // Functions: many functions in one file = complex
  if (functionCount > 15) complexityScore += 30;
  else if (functionCount > 8) complexityScore += 20;
  else if (functionCount > 3) complexityScore += 10;
  else complexityScore += 5;

  // Imports: many dependencies = complex
  if (imports.length > 15) complexityScore += 20;
  else if (imports.length > 8) complexityScore += 12;
  else if (imports.length > 3) complexityScore += 6;
  else complexityScore += 2;

  // Max nesting depth (count indent levels)
  let maxNesting = 0;
  for (const line of lines) {
    const stripped = line.replace(/\t/g, '    ');
    const indent = stripped.length - stripped.trimStart().length;
    const nestLevel = Math.floor(indent / 2);
    if (nestLevel > maxNesting) maxNesting = nestLevel;
  }
  if (maxNesting > 8) complexityScore += 10;
  else if (maxNesting > 5) complexityScore += 5;

  complexityScore = Math.min(complexityScore, 100);

  const complexityLabel = complexityScore >= 70 ? 'High' :
    complexityScore >= 40 ? 'Moderate' : 'Low';
  const complexityDescription = complexityScore >= 70
    ? 'This file has high complexity and may benefit from refactoring'
    : complexityScore >= 40
    ? 'Moderate complexity -- manageable but watch for growth'
    : 'Well-scoped file with low complexity';

  // Suggestions
  const suggestions: string[] = [];
  if (lineCount > 300) {
    suggestions.push(`This file has ${lineCount} lines. Consider splitting into smaller modules.`);
  }
  if (functionCount > 10) {
    suggestions.push(`${functionCount} functions detected. Extract related functions into separate files.`);
  }
  if (imports.length > 12) {
    suggestions.push(`${imports.length} imports detected. Some may be consolidatable or unnecessary.`);
  }
  if (maxNesting > 6) {
    suggestions.push('Deep nesting detected. Consider extracting nested logic into helper functions.');
  }
  if (exports.length === 0 && !path.includes('index') && !path.endsWith('.css')) {
    suggestions.push('No exports found. If this is a module, consider adding named exports.');
  }
  if (suggestions.length === 0) {
    suggestions.push('This file looks well-structured. No immediate improvements needed.');
  }

  return {
    complexity: { score: complexityScore, label: complexityLabel, description: complexityDescription },
    imports: [...new Set(imports)],
    exports,
    lineCount,
    suggestions,
    language,
    functionCount,
  };
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function ComplexityBadge({ score, label }: { score: number; label: string }) {
  const color = score >= 70 ? 'text-danger bg-danger/10 border-danger/20' :
    score >= 40 ? 'text-warning bg-warning/10 border-warning/20' :
    'text-success bg-success/10 border-success/20';

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold rounded-pill border ${color}`}>
      <Cpu size={10} />
      {label} ({score})
    </span>
  );
}

export function FileInsights({ filePath, content, lastModified, isAiGenerated, fileSize, className = '' }: FileInsightsProps) {
  const [expanded, setExpanded] = useState(false);
  const insights = useMemo(() => analyzeFile(filePath, content), [filePath, content]);

  const fileName = filePath.split('/').pop() || filePath;

  return (
    <div className={`border-t border-border bg-card ${className}`}>
      {/* Trigger bar */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-hover/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Info size={13} className="text-primary" />
          <span className="text-xs font-medium text-ink">File Insights</span>
          <span className="text-[11px] text-muted font-mono">{insights.language}</span>
          <ComplexityBadge score={insights.complexity.score} label={insights.complexity.label} />
        </div>
        <span className="text-muted">
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3">
          {/* File metadata */}
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="flex items-center gap-1.5 text-muted">
              <FileCode2 size={12} />
              <span>{insights.lineCount} lines, {insights.functionCount} functions</span>
            </div>
            {fileSize !== undefined && (
              <div className="flex items-center gap-1.5 text-muted">
                <FileCode2 size={12} />
                <span>{formatFileSize(fileSize)}</span>
              </div>
            )}
            {lastModified && (
              <div className="flex items-center gap-1.5 text-muted">
                <Clock size={12} />
                <span>{formatDate(lastModified)}</span>
              </div>
            )}
            {isAiGenerated !== undefined && (
              <div className="flex items-center gap-1.5">
                <Cpu size={12} className={isAiGenerated ? 'text-primary' : 'text-muted'} />
                <span className={`text-xs ${isAiGenerated ? 'text-primary font-medium' : 'text-muted'}`}>
                  {isAiGenerated ? 'AI-generated' : 'User-modified'}
                </span>
              </div>
            )}
          </div>

          {/* Dependencies */}
          {insights.imports.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-1.5">
                <Link2 size={11} className="text-muted" />
                <span className="text-[11px] font-semibold text-muted uppercase tracking-wider">
                  Dependencies ({insights.imports.length})
                </span>
              </div>
              <div className="flex flex-wrap gap-1">
                {insights.imports.slice(0, 12).map(imp => (
                  <span
                    key={imp}
                    className="px-2 py-0.5 text-[11px] font-mono bg-hover rounded-card text-secondary truncate max-w-[180px]"
                    title={imp}
                  >
                    {imp}
                  </span>
                ))}
                {insights.imports.length > 12 && (
                  <span className="px-2 py-0.5 text-[11px] text-muted">
                    +{insights.imports.length - 12} more
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Exports */}
          {insights.exports.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-1.5">
                <GitBranch size={11} className="text-muted" />
                <span className="text-[11px] font-semibold text-muted uppercase tracking-wider">
                  Exports ({insights.exports.length})
                </span>
              </div>
              <div className="flex flex-wrap gap-1">
                {insights.exports.map(exp => (
                  <span
                    key={exp}
                    className="px-2 py-0.5 text-[11px] font-mono bg-primary/8 text-primary rounded-card"
                  >
                    {exp}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Suggestions */}
          <div className="bg-primary/5 border border-primary/10 rounded-card p-2.5">
            <div className="flex items-center gap-1.5 mb-1.5">
              <Lightbulb size={11} className="text-primary" />
              <span className="text-[11px] font-semibold text-primary uppercase tracking-wider">
                Insights
              </span>
            </div>
            <ul className="space-y-1">
              {insights.suggestions.map((s, i) => (
                <li key={i} className="text-xs text-secondary flex items-start gap-1.5">
                  <span className="text-primary mt-0.5 flex-shrink-0">--</span>
                  {s}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
