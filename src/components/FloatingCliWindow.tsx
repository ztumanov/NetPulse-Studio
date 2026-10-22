import React, { useState, useRef, useEffect } from 'react';
import {
  NetworkLink,
  NetworkNode,
  SimulationStep,
} from '../network/types';
import {
  autocompleteIosCommand,
  executeIosCommand,
  getCliPrompt,
} from '../network/cliParser';
import {
  Terminal,
  X,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  GripHorizontal,
  Sparkles,
  Trash2,
} from 'lucide-react';

interface FloatingCliWindowProps {
  openNodeIds: string[];
  activeNodeId: string | null;
  allNodes: NetworkNode[];
  allLinks: NetworkLink[];
  onSelectTab: (nodeId: string) => void;
  onCloseTab: (nodeId: string) => void;
  onCloseWindow: () => void;
  onAddDeviceTab: (nodeId: string) => void;
  onUpdateNode: (updatedNode: NetworkNode) => void;
  onUpdateAllNodes: (updatedNodes: NetworkNode[]) => void;
  onLoadSimulationSteps: (steps: SimulationStep[], summaryMessage: string) => void;
}

export const FloatingCliWindow: React.FC<FloatingCliWindowProps> = ({
  openNodeIds,
  activeNodeId,
  allNodes,
  allLinks,
  onSelectTab,
  onCloseTab,
  onCloseWindow,
  onAddDeviceTab,
  onUpdateNode,
  onUpdateAllNodes,
  onLoadSimulationSteps,
}) => {
  const [position, setPosition] = useState<{ x: number; y: number }>({
    x: 220,
    y: 130,
  });
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isMinimized, setIsMinimized] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  const [cliInput, setCliInput] = useState('');
  const [historyCursor, setHistoryCursor] = useState<number>(-1);
  const [cliSuggestions, setCliSuggestions] = useState<string[]>([]);

  const terminalEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const activeNode =
    allNodes.find((n) => n.id === activeNodeId) ||
    allNodes.find((n) => openNodeIds.includes(n.id)) ||
    null;

  useEffect(() => {
    if (!isMinimized && activeNode) {
      terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      inputRef.current?.focus();
    }
  }, [activeNode?.id, activeNode?.cli.history.length, isMinimized]);

  useEffect(() => {
    if (!isDragging) return;
    const handleMouseMove = (e: MouseEvent) => {
      const nextX = Math.max(16, Math.min(window.innerWidth - 360, e.clientX - dragOffset.x));
      const nextY = Math.max(48, Math.min(window.innerHeight - 120, e.clientY - dragOffset.y));
      setPosition({ x: nextX, y: nextY });
    };
    const handleMouseUp = () => {
      setIsDragging(false);
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, dragOffset]);

  if (!activeNode || openNodeIds.length === 0) {
    return null;
  }

  const handleHeaderMouseDown = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('select')) return;
    setIsDragging(true);
    setDragOffset({
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    });
  };

  const runCommandOnActiveNode = (rawCmd: string) => {
    const res = executeIosCommand(rawCmd, activeNode, allNodes, allLinks);
    const updatedWithHistory: NetworkNode = {
      ...res.updatedNode,
      cli: {
        ...res.updatedNode.cli,
        history: [...activeNode.cli.history, ...res.outputLines],
      },
    };

    if (res.updatedAllNodes) {
      const merged = res.updatedAllNodes.map((n) =>
        n.id === updatedWithHistory.id ? updatedWithHistory : n
      );
      onUpdateAllNodes(merged);
    } else {
      onUpdateNode(updatedWithHistory);
    }

    if (res.triggeredSimulationSteps && res.triggeredSummaryMessage) {
      onLoadSimulationSteps(res.triggeredSimulationSteps, res.triggeredSummaryMessage);
    }
  };

  const handleCliSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    runCommandOnActiveNode(cliInput);
    setCliInput('');
    setHistoryCursor(-1);
    setCliSuggestions([]);
  };

  const handleCliKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const { completed, suggestions } = autocompleteIosCommand(cliInput, activeNode);
      setCliInput(completed);
      setCliSuggestions(suggestions.length > 1 ? suggestions : []);
      return;
    }

    const cmdLog = activeNode.cli.commandLog || [];
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (cmdLog.length === 0) return;
      const nextCursor =
        historyCursor === -1 ? cmdLog.length - 1 : Math.max(0, historyCursor - 1);
      setHistoryCursor(nextCursor);
      setCliInput(cmdLog[nextCursor] || '');
      setCliSuggestions([]);
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (cmdLog.length === 0 || historyCursor === -1) return;
      const nextCursor = historyCursor + 1;
      if (nextCursor >= cmdLog.length) {
        setHistoryCursor(-1);
        setCliInput('');
      } else {
        setHistoryCursor(nextCursor);
        setCliInput(cmdLog[nextCursor] || '');
      }
      setCliSuggestions([]);
    }
  };

  const handleClearTerminal = () => {
    onUpdateNode({
      ...activeNode,
      cli: {
        ...activeNode.cli,
        history: [`Консоль ${activeNode.name} очищена. Введите "?" для списка команд.`],
      },
    });
  };

  const quickCommands =
    activeNode.type === 'switch'
      ? ['show ip int brief', 'show vlan brief', 'show mac-address-table', 'conf t', 'wr']
      : activeNode.type === 'router'
      ? ['show ip int brief', 'show ip route', 'show ip arp', 'conf t', 'wr']
      : ['ipconfig', 'ipconfig /renew', 'arp -a', 'ping 192.168.2.100', 'traceroute 192.168.2.100'];

  const unopenedNodes = allNodes.filter((n) => !openNodeIds.includes(n.id));

  return (
    <div
      data-testid="floating-cli-window"
      role="dialog"
      aria-label={`Терминал CLI — ${activeNode.name}`}
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        width: isMinimized ? '360px' : isExpanded ? '780px' : '600px',
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      className="fixed z-50 rounded-lg bg-slate-950/98 border-2 border-slate-700 shadow-[0_24px_60px_rgba(0,0,0,0.85)] flex flex-col overflow-hidden select-none"
    >
      {/* Draggable Terminal Title Bar */}
      <div
        onMouseDown={handleHeaderMouseDown}
        className="flex items-center justify-between gap-2 px-3 py-2 bg-slate-900 border-b border-slate-800 cursor-move"
      >
        <div className="flex items-center gap-2 min-w-0">
          <GripHorizontal className="w-4 h-4 text-slate-500 shrink-0" />
          <Terminal className="w-4 h-4 text-emerald-400 shrink-0" />
          <span className="text-xs font-mono font-bold text-slate-100 truncate">
            Cisco IOS CLI · {activeNode.name} ({activeNode.type.toUpperCase()})
          </span>
          <span className="hidden sm:inline text-[10px] font-mono text-emerald-400 bg-emerald-950/80 border border-emerald-700/50 px-1.5 py-0.5 rounded">
            TTY0 · 9600 8N1
          </span>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={handleClearTerminal}
            title="Очистить экран терминала"
            aria-label="Очистить экран терминала"
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setIsMinimized((m) => !m)}
            title={isMinimized ? 'Развернуть окно терминала' : 'Свернуть окно в заголовок'}
            aria-label={isMinimized ? 'Развернуть окно терминала' : 'Свернуть окно терминала'}
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          {!isMinimized && (
            <button
              type="button"
              onClick={() => setIsExpanded((e) => !e)}
              title={isExpanded ? 'Обычный размер окна' : 'Увеличить окно терминала'}
              aria-label={isExpanded ? 'Обычный размер окна' : 'Увеличить окно терминала'}
              className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            >
              {isExpanded ? (
                <Minimize2 className="w-3.5 h-3.5" />
              ) : (
                <Maximize2 className="w-3.5 h-3.5" />
              )}
            </button>
          )}
          <button
            type="button"
            onClick={onCloseWindow}
            title="Закрыть плавающий терминал CLI"
            aria-label="Закрыть плавающий терминал CLI"
            className="p-1 rounded text-slate-400 hover:text-red-300 hover:bg-red-950/60 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {!isMinimized && (
        <>
          {/* Multi-Session Device Tabs Bar */}
          <div className="flex items-center justify-between gap-2 px-2 py-1 bg-slate-900/70 border-b border-slate-800/80 overflow-x-auto">
            <div className="flex items-center gap-1 overflow-x-auto">
              {openNodeIds.map((id) => {
                const tabNode = allNodes.find((n) => n.id === id);
                if (!tabNode) return null;
                const isActive = tabNode.id === activeNode.id;

                return (
                  <div
                    key={tabNode.id}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono transition-colors ${
                      isActive
                        ? 'bg-slate-800 text-sky-300 border border-sky-500/40 font-semibold'
                        : 'bg-slate-950/60 text-slate-400 hover:text-slate-200 border border-slate-800'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectTab(tabNode.id)}
                      className="cursor-pointer whitespace-nowrap"
                    >
                      {tabNode.name}
                    </button>
                    {openNodeIds.length > 1 && (
                      <button
                        type="button"
                        onClick={() => onCloseTab(tabNode.id)}
                        aria-label={`Закрыть вкладку ${tabNode.name}`}
                        className="text-slate-500 hover:text-red-300"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Quick Add Another Device Session to Floating Terminal */}
            {unopenedNodes.length > 0 && (
              <div className="flex items-center gap-1 shrink-0">
                <Plus className="w-3 h-3 text-slate-400" />
                <select
                  aria-label="Открыть ещё одно устройство во вкладке терминала"
                  value=""
                  onChange={(e) => {
                    if (e.target.value) {
                      onAddDeviceTab(e.target.value);
                    }
                  }}
                  className="bg-slate-950 border border-slate-800 rounded px-2 py-0.5 text-[11px] font-mono text-slate-300 focus:outline-none focus:border-sky-500"
                >
                  <option value="">+ Сессия к узлу...</option>
                  {unopenedNodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name} ({n.type.toUpperCase()})
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Quick Command Chips Bar */}
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-950 border-b border-slate-900 overflow-x-auto">
            <span className="text-[10px] font-mono text-slate-500 shrink-0">Быстро:</span>
            {quickCommands.map((cmd) => (
              <button
                key={cmd}
                type="button"
                onClick={() => runCommandOnActiveNode(cmd)}
                className="px-2 py-0.5 text-[11px] font-mono rounded bg-slate-900 hover:bg-slate-800 text-sky-300 border border-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {cmd}
              </button>
            ))}
          </div>

          {/* Terminal Console Scroll Output */}
          <div
            onClick={() => inputRef.current?.focus()}
            className={`${
              isExpanded ? 'h-[390px]' : 'h-[280px]'
            } overflow-y-auto p-3.5 font-mono text-xs leading-relaxed bg-[#050811] text-emerald-400 space-y-1 select-text cursor-text`}
          >
            {activeNode.cli.history.map((line, idx) => (
              <div key={idx} className="whitespace-pre-wrap break-words">
                {line}
              </div>
            ))}
            <div ref={terminalEndRef} />
          </div>

          {/* Tab Autocomplete Suggestions Bar */}
          {cliSuggestions.length > 0 && (
            <div className="px-3 py-1 bg-slate-900 border-t border-slate-800 text-[11px] font-mono text-sky-300 flex items-center gap-2 flex-wrap">
              <Sparkles className="w-3 h-3 text-sky-400 shrink-0" />
              <span className="text-slate-400">Tab:</span>
              {cliSuggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    setCliInput(s + ' ');
                    setCliSuggestions([]);
                    inputRef.current?.focus();
                  }}
                  className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-sky-600/30 text-sky-200"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          {/* Command Prompt Input Line */}
          <form
            onSubmit={handleCliSubmit}
            className="flex items-center gap-2 px-3.5 py-2 bg-slate-900 border-t border-slate-800"
          >
            <span className="text-xs font-mono font-bold text-emerald-400 whitespace-nowrap shrink-0">
              {getCliPrompt(activeNode)}
            </span>
            <input
              ref={inputRef}
              type="text"
              aria-label="Ввод команды в плавающем терминале CLI"
              value={cliInput}
              onChange={(e) => setCliInput(e.target.value)}
              onKeyDown={handleCliKeyDown}
              placeholder="Введите команду (Tab — автодополнение, ↑/↓ — история)..."
              className="flex-1 bg-transparent text-xs font-mono text-slate-100 focus:outline-none"
            />
            <button
              type="submit"
              className="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-mono font-medium transition-colors shrink-0 cursor-pointer"
            >
              Выполнить
            </button>
          </form>
        </>
      )}
    </div>
  );
};
