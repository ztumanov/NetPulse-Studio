import React, { useState } from 'react';
import { CableType, DeviceModel, DeviceType, PresetTestScenario } from '../network/types';
import { TOPOLOGY_PRESETS } from '../network/presets';
import { PendingCanvasPlacement, WorkspaceTool } from './TopologyCanvas';
import {
  MousePointer,
  Cable,
  Mail,
  Trash2,
  Router,
  Network,
  Monitor,
  Server,
  Download,
  Upload,
  Sparkles,
  Layers,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Wifi,
  Radio,
  Laptop,
  Smartphone,
  Shield,
  PhoneCall,
  Camera,
  Video,
  Cloud,
  Zap,
  Cpu,
} from 'lucide-react';

interface DeviceToolbarProps {
  activeTool: WorkspaceTool;
  selectedCableType: CableType;
  activePresetId: string;
  isCollapsed: boolean;
  pendingPlacement?: PendingCanvasPlacement | null;
  onToggleCollapse: () => void;
  onSelectTool: (tool: WorkspaceTool) => void;
  onSelectCableType: (type: CableType) => void;
  onAddDevice: (
    type: DeviceType,
    switchPortCount?: number,
    deviceModel?: DeviceModel
  ) => void;
  onAddZone: () => void;
  onLoadPreset: (presetId: string) => void;
  onRunPresetTest?: (scenario: PresetTestScenario) => void;
  onOpenCoreDiagnostics?: () => void;
  onClearCanvas: () => void;
  onExportJson: () => void;
  onImportJson: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export const DeviceToolbar: React.FC<DeviceToolbarProps> = ({
  activeTool,
  selectedCableType,
  activePresetId,
  isCollapsed,
  pendingPlacement,
  onToggleCollapse,
  onSelectTool,
  onSelectCableType,
  onAddDevice,
  onAddZone,
  onLoadPreset,
  onRunPresetTest,
  onOpenCoreDiagnostics,
  onClearCanvas,
  onExportJson,
  onImportJson,
}) => {
  const isDeviceArmed = (
    type: DeviceType,
    switchPortCount: number = 6,
    deviceModel?: DeviceModel
  ) => {
    if (!pendingPlacement || pendingPlacement.kind !== 'device') return false;
    return (
      pendingPlacement.type === type &&
      (pendingPlacement.switchPortCount ?? 6) === switchPortCount &&
      pendingPlacement.deviceModel === deviceModel
    );
  };

  const armedBtnClass = (armed: boolean, defaultBorder = 'border-slate-800 hover:border-slate-700') =>
    armed
      ? 'bg-sky-500/20 border-sky-400 text-sky-100 ring-1 ring-sky-400 shadow-xs'
      : `bg-slate-950/90 hover:bg-slate-800 ${defaultBorder} text-slate-200`;
  const [presetsOpen, setPresetsOpen] = useState(true);
  const [openCategories, setOpenCategories] = useState<{
    routing: boolean;
    switching: boolean;
    wireless: boolean;
    endpoints: boolean;
  }>({
    routing: true,
    switching: true,
    wireless: true,
    endpoints: true,
  });

  const toggleCategory = (key: keyof typeof openCategories) => {
    setOpenCategories((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const allCategoriesOpen =
    openCategories.routing &&
    openCategories.switching &&
    openCategories.wireless &&
    openCategories.endpoints;

  const toggleAllCategories = () => {
    const next = !allCategoriesOpen;
    setOpenCategories({
      routing: next,
      switching: next,
      wireless: next,
      endpoints: next,
    });
  };

  const activePreset = TOPOLOGY_PRESETS.find((p) => p.id === activePresetId) || TOPOLOGY_PRESETS[0];

  // Compact 56px Icon Rail Mode when collapsed
  if (isCollapsed) {
    return (
      <aside
        aria-label="Свёрнутая палитра инструментов"
        className="w-14 border-r border-slate-800 bg-slate-900 flex flex-col items-center justify-between py-3 shrink-0 select-none"
      >
        <div className="flex flex-col items-center gap-2 w-full px-1.5">
          <button
            onClick={onToggleCollapse}
            title="Развернуть левую панель инструментов"
            aria-label="Развернуть левую панель инструментов"
            className="p-2 rounded-md text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <PanelLeftOpen className="w-4 h-4" />
          </button>

          <div className="w-7 h-px bg-slate-800 my-0.5" />

          {/* Tools */}
          <button
            onClick={() => onSelectTool('select')}
            title="Курсор (Выбор и перемещение)"
            aria-label="Курсор"
            className={`p-2 rounded-md border transition-colors ${
              activeTool === 'select'
                ? 'bg-sky-500/20 border-sky-500/50 text-sky-300'
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            <MousePointer className="w-4 h-4" />
          </button>

          <button
            onClick={() => onSelectTool('cable')}
            title="Кабель (Подключение портов)"
            aria-label="Кабель"
            className={`p-2 rounded-md border transition-colors ${
              activeTool === 'cable'
                ? 'bg-sky-500/20 border-sky-500/50 text-sky-300'
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            <Cable className="w-4 h-4" />
          </button>

          <button
            onClick={() => onSelectTool('pdu')}
            title="Пакет PDU (Быстрый Ping между двумя узлами)"
            aria-label="Пакет PDU"
            className={`p-2 rounded-md border transition-colors ${
              activeTool === 'pdu'
                ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            <Mail className="w-4 h-4" />
          </button>

          <button
            onClick={() => onSelectTool('delete')}
            title="Удалить узел, кабель или зону"
            aria-label="Удалить"
            className={`p-2 rounded-md border transition-colors ${
              activeTool === 'delete'
                ? 'bg-red-500/20 border-red-500/50 text-red-300'
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            <Trash2 className="w-4 h-4" />
          </button>

          <div className="w-7 h-px bg-slate-800 my-0.5" />

          {/* Quick Add Devices & Zone */}
          <button
            onClick={() => onAddDevice('router')}
            title="Добавить Router (ISR L3)"
            aria-label="Добавить Router"
            className="p-2 rounded-md text-sky-400 hover:bg-slate-800 transition-colors"
          >
            <Router className="w-4 h-4" />
          </button>
          <button
            onClick={() => onAddDevice('router', 3, 'firewall')}
            title="Добавить Межсетевой экран Firewall (Cisco ASA / FortiGate)"
            aria-label="Добавить Firewall"
            className="p-2 rounded-md text-rose-400 hover:bg-slate-800 transition-colors"
          >
            <Shield className="w-4 h-4" />
          </button>
          <button
            onClick={() => onAddDevice('router', 4, 'isp_cloud')}
            title="Добавить Узел Провайдера / WAN-облако (ISP Cloud · eBGP · Эмулятор канала)"
            aria-label="Добавить WAN / ISP Cloud"
            className="p-2 rounded-md text-orange-400 hover:bg-slate-800 transition-colors"
          >
            <Cloud className="w-4 h-4" />
          </button>
          <button
            onClick={() => onAddDevice('switch', 6)}
            title="Добавить Switch 6 портов (Catalyst L2)"
            aria-label="Добавить Switch 6 портов"
            className="p-2 rounded-md text-indigo-400 hover:bg-slate-800 transition-colors"
          >
            <Network className="w-4 h-4" />
          </button>
          <button
            onClick={() => onAddDevice('switch', 24)}
            title="Добавить Switch 24 порта (Catalyst 2960-24TT L2)"
            aria-label="Добавить Switch 24 порта"
            className="px-1.5 py-1 rounded-md text-[10px] font-mono font-bold text-indigo-300 border border-indigo-500/40 hover:bg-slate-800 transition-colors"
          >
            24P
          </button>
          <button
            onClick={() => onAddDevice('switch', 6, 'gpon_olt')}
            title="Добавить Оптический терминал провайдера GPON OLT (1490/1310 нм · Сплиттер 1:N)"
            aria-label="Добавить GPON OLT"
            className="p-2 rounded-md text-emerald-400 hover:bg-slate-800 transition-colors"
          >
            <Zap className="w-4 h-4" />
          </button>
          <button
            onClick={() => onAddDevice('switch', 4, 'gpon_ont')}
            title="Добавить Абонентский оптический модем ONT / ONU (FTTH · Контроль dBm / LOS)"
            aria-label="Добавить ONT / ONU"
            className="p-2 rounded-md text-teal-400 hover:bg-slate-800 transition-colors"
          >
            <Cpu className="w-4 h-4" />
          </button>
          <button
            onClick={() => onAddDevice('pc')}
            title="Добавить Рабочую станцию (PC)"
            aria-label="Добавить PC"
            className="p-2 rounded-md text-slate-200 hover:bg-slate-800 transition-colors"
          >
            <Monitor className="w-4 h-4" />
          </button>
          <button
            onClick={() => onAddDevice('server')}
            title="Добавить Сервер (HTTP/DNS/DHCP)"
            aria-label="Добавить Server"
            className="p-2 rounded-md text-emerald-400 hover:bg-slate-800 transition-colors"
          >
            <Server className="w-4 h-4" />
          </button>
          <button
            onClick={() => onAddDevice('switch', 6, 'wifi_ap')}
            title="Добавить Точку доступа Wi-Fi (802.11 AP)"
            aria-label="Добавить Wi-Fi AP"
            className="p-2 rounded-md text-cyan-400 hover:bg-slate-800 transition-colors"
          >
            <Wifi className="w-4 h-4" />
          </button>
          <button
            onClick={() => onAddDevice('pc', 6, 'laptop')}
            title="Добавить Ноутбук (Wi-Fi Client)"
            aria-label="Добавить Ноутбук"
            className="p-2 rounded-md text-violet-300 hover:bg-slate-800 transition-colors"
          >
            <Laptop className="w-4 h-4" />
          </button>
          <button
            onClick={() => onAddDevice('pc', 2, 'ip_phone')}
            title="Добавить IP-Телефон (Cisco IP Phone 7960 · VoIP SIP / PoE)"
            aria-label="Добавить IP-Телефон"
            className="p-2 rounded-md text-fuchsia-400 hover:bg-slate-800 transition-colors"
          >
            <PhoneCall className="w-4 h-4" />
          </button>
          <button
            onClick={() => onAddDevice('pc', 1, 'ip_camera')}
            title="Добавить PoE IP-Камеру (RTSP / Multicast · VLAN 30)"
            aria-label="Добавить IP-Камеру"
            className="p-2 rounded-md text-teal-400 hover:bg-slate-800 transition-colors"
          >
            <Camera className="w-4 h-4" />
          </button>
          <button
            onClick={() => onAddDevice('server', 1, 'nvr')}
            title="Добавить Видеорегистратор NVR (RTSP Server · RAID-6)"
            aria-label="Добавить NVR"
            className="p-2 rounded-md text-teal-300 hover:bg-slate-800 transition-colors"
          >
            <Video className="w-4 h-4" />
          </button>
          <button
            onClick={onAddZone}
            title="Добавить визуальную зону подсети / VLAN"
            aria-label="Добавить зону подсети"
            className="p-2 rounded-md text-sky-300 hover:bg-sky-950/60 transition-colors"
          >
            <Layers className="w-4 h-4" />
          </button>
        </div>

        <div className="flex flex-col items-center gap-1.5">
          <button
            onClick={onExportJson}
            title="Экспорт топологии в JSON"
            aria-label="Экспорт топологии"
            className="p-2 rounded-md text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
          >
            <Download className="w-4 h-4" />
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside
      aria-label="Палитра оборудования и инструментов проектирования"
      className="w-56 border-r border-slate-800 bg-slate-900 flex flex-col justify-between p-3 shrink-0 select-none overflow-y-auto"
    >
      <div className="space-y-4">
        {/* Header with Collapse Button */}
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-300">Инструменты</span>
          <button
            onClick={onToggleCollapse}
            title="Свернуть левую панель в компактную полосу иконок"
            aria-label="Свернуть левую панель"
            className="flex items-center gap-1 px-1.5 py-1 rounded text-[11px] text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
          >
            <PanelLeftClose className="w-3.5 h-3.5" />
            <span>Свернуть</span>
          </button>
        </div>

        {/* Section 1: Workspace Mode Tools */}
        <div>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={() => onSelectTool('select')}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                activeTool === 'select'
                  ? 'bg-sky-500/20 border-sky-500/50 text-sky-300'
                  : 'bg-slate-950/80 border-slate-800 text-slate-300 hover:bg-slate-800'
              }`}
            >
              <MousePointer className="w-3.5 h-3.5 shrink-0" />
              <span>Курсор</span>
            </button>

            <button
              onClick={() => onSelectTool('cable')}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                activeTool === 'cable'
                  ? 'bg-sky-500/20 border-sky-500/50 text-sky-300'
                  : 'bg-slate-950/80 border-slate-800 text-slate-300 hover:bg-slate-800'
              }`}
            >
              <Cable className="w-3.5 h-3.5 shrink-0" />
              <span>Кабель</span>
            </button>

            <button
              onClick={() => onSelectTool('pdu')}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                activeTool === 'pdu'
                  ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
                  : 'bg-slate-950/80 border-slate-800 text-slate-300 hover:bg-slate-800'
              }`}
            >
              <Mail className="w-3.5 h-3.5 shrink-0" />
              <span>Пакет PDU</span>
            </button>

            <button
              onClick={() => onSelectTool('delete')}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                activeTool === 'delete'
                  ? 'bg-red-500/20 border-red-500/50 text-red-300'
                  : 'bg-slate-950/80 border-slate-800 text-slate-300 hover:bg-slate-800'
              }`}
            >
              <Trash2 className="w-3.5 h-3.5 shrink-0" />
              <span>Удалить</span>
            </button>
          </div>

          {/* Cable Sub-type selector when Cable tool is active */}
          {activeTool === 'cable' && (
            <div className="mt-2 p-2 rounded bg-slate-950 border border-slate-800 space-y-1">
              <div className="text-[11px] text-slate-400">Тип патч-корда:</div>
              {(
                [
                  { id: 'straight', label: 'Медный прямой (Straight)' },
                  { id: 'crossover', label: 'Медный кросс (Crossover)' },
                  { id: 'fiber', label: 'Оптоволокно (Fiber SFP)' },
                  { id: 'stack', label: 'Стек-кабель (StackWise / HA)' },
                ] as const
              ).map((c) => (
                <button
                  key={c.id}
                  data-testid={`cable-type-${c.id}`}
                  onClick={() => onSelectCableType(c.id)}
                  className={`w-full text-left px-2 py-1 text-xs rounded transition-colors cursor-pointer ${
                    selectedCableType === c.id
                      ? c.id === 'stack'
                        ? 'bg-amber-500/20 text-amber-300 font-medium border border-amber-500/40'
                        : 'bg-sky-500/20 text-sky-300 font-medium'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Section 2: Categorized & Collapsible Network Hardware Palette */}
        <div className="pt-3 border-t border-slate-800 space-y-2">
          <div className="flex items-center justify-between gap-1">
            <span className="text-xs font-semibold text-slate-300 whitespace-nowrap">
              Добавить на холст
            </span>
            <button
              type="button"
              data-testid="toggle-all-device-categories-btn"
              onClick={toggleAllCategories}
              className="text-[10px] font-mono text-slate-400 hover:text-slate-200 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              {allCategoriesOpen ? 'Свернуть все' : 'Развернуть'}
            </button>
          </div>

          <div className="space-y-1.5">
            {/* Category 1: Routing & Security (L3 / NGFW) */}
            <div className="rounded-md border border-slate-800/90 bg-slate-950/40 overflow-hidden">
              <button
                type="button"
                data-testid="device-cat-toggle-routing"
                onClick={() => toggleCategory('routing')}
                className="w-full flex items-center justify-between px-2.5 py-1.5 bg-slate-900/80 hover:bg-slate-800/80 text-[11px] font-semibold text-slate-200 transition-colors cursor-pointer"
              >
                <span className="flex items-center gap-1.5 truncate">
                  <Router className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                  <span className="truncate">Маршрутизация L3</span>
                </span>
                <span className="flex items-center gap-1 shrink-0">
                  <span className="text-[10px] font-mono text-slate-400">3</span>
                  {openCategories.routing ? (
                    <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                  )}
                </span>
              </button>

              {openCategories.routing && (
                <div className="p-1.5 space-y-1 border-t border-slate-800/70">
                  <button
                    type="button"
                    data-testid="add-router-btn"
                    onClick={() => onAddDevice('router')}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md border text-xs transition-colors cursor-pointer ${armedBtnClass(
                      isDeviceArmed('router', 6, undefined)
                    )}`}
                  >
                    <span className="flex items-center gap-2 font-medium min-w-0">
                      <Router className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                      <span className="truncate">Router (L3)</span>
                    </span>
                    <span className="text-[10px] font-mono text-slate-400 shrink-0 ml-1.5">
                      {isDeviceArmed('router', 6, undefined) ? '+ Клик' : '3 порта'}
                    </span>
                  </button>

                  <button
                    type="button"
                    data-testid="add-firewall-btn"
                    onClick={() => onAddDevice('router', 3, 'firewall')}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md border text-xs transition-colors cursor-pointer ${armedBtnClass(
                      isDeviceArmed('router', 3, 'firewall')
                    )}`}
                  >
                    <span className="flex items-center gap-2 font-medium min-w-0">
                      <Shield className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                      <span className="truncate">Firewall (ASA)</span>
                    </span>
                    <span className="text-[10px] font-mono text-slate-400 shrink-0 ml-1.5">
                      {isDeviceArmed('router', 3, 'firewall') ? '+ Клик' : 'SPI · VPN'}
                    </span>
                  </button>

                  <button
                    type="button"
                    data-testid="add-isp-cloud-btn"
                    onClick={() => onAddDevice('router', 4, 'isp_cloud')}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md border text-xs transition-colors cursor-pointer ${armedBtnClass(
                      isDeviceArmed('router', 4, 'isp_cloud')
                    )}`}
                  >
                    <span className="flex items-center gap-2 font-medium min-w-0">
                      <Cloud className="w-3.5 h-3.5 text-orange-400 shrink-0" />
                      <span className="truncate">WAN / Облако ISP</span>
                    </span>
                    <span className="text-[10px] font-mono text-slate-400 shrink-0 ml-1.5">
                      {isDeviceArmed('router', 4, 'isp_cloud') ? '+ Клик' : 'eBGP · WAN'}
                    </span>
                  </button>
                </div>
              )}
            </div>

            {/* Category 2: Switching & GPON Optical (L2 / L3 SVI / FTTH) */}
            <div className="rounded-md border border-slate-800/90 bg-slate-950/40 overflow-hidden">
              <button
                type="button"
                data-testid="device-cat-toggle-switching"
                onClick={() => toggleCategory('switching')}
                className="w-full flex items-center justify-between px-2.5 py-1.5 bg-slate-900/80 hover:bg-slate-800/80 text-[11px] font-semibold text-slate-200 transition-colors cursor-pointer"
              >
                <span className="flex items-center gap-1.5 truncate">
                  <Network className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                  <span className="truncate">Коммутация и GPON</span>
                </span>
                <span className="flex items-center gap-1 shrink-0">
                  <span className="text-[10px] font-mono text-slate-400">4</span>
                  {openCategories.switching ? (
                    <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                  )}
                </span>
              </button>

              {openCategories.switching && (
                <div className="p-1.5 space-y-1 border-t border-slate-800/70">
                  <button
                    type="button"
                    data-testid="add-switch-6-btn"
                    onClick={() => onAddDevice('switch', 6)}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md border text-xs transition-colors cursor-pointer ${armedBtnClass(
                      isDeviceArmed('switch', 6, undefined)
                    )}`}
                  >
                    <span className="flex items-center gap-2 font-medium min-w-0">
                      <Network className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                      <span className="truncate">Switch 6p</span>
                    </span>
                    <span className="text-[10px] font-mono text-slate-400 shrink-0 ml-1.5">
                      {isDeviceArmed('switch', 6, undefined) ? '+ Клик' : '6 портов'}
                    </span>
                  </button>

                  <button
                    type="button"
                    data-testid="add-switch-24-btn"
                    onClick={() => onAddDevice('switch', 24)}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md border text-xs transition-colors cursor-pointer ${armedBtnClass(
                      isDeviceArmed('switch', 24, undefined)
                    )}`}
                  >
                    <span className="flex items-center gap-2 font-medium min-w-0">
                      <Network className="w-3.5 h-3.5 text-indigo-300 shrink-0" />
                      <span className="truncate">Switch 24p</span>
                    </span>
                    <span className="text-[10px] font-mono text-slate-400 shrink-0 ml-1.5">
                      {isDeviceArmed('switch', 24, undefined) ? '+ Клик' : '24 порта'}
                    </span>
                  </button>

                  <button
                    type="button"
                    data-testid="add-gpon-olt-btn"
                    onClick={() => onAddDevice('switch', 6, 'gpon_olt')}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md border text-xs transition-colors cursor-pointer ${armedBtnClass(
                      isDeviceArmed('switch', 6, 'gpon_olt'),
                      'border-emerald-500/30 hover:border-emerald-500/60'
                    )}`}
                  >
                    <span className="flex items-center gap-2 font-medium min-w-0">
                      <Zap className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      <span className="truncate">GPON OLT</span>
                    </span>
                    <span className="text-[10px] font-mono text-emerald-300 shrink-0 ml-1.5">
                      {isDeviceArmed('switch', 6, 'gpon_olt') ? '+ Клик' : '1490/1310нм'}
                    </span>
                  </button>

                  <button
                    type="button"
                    data-testid="add-gpon-ont-btn"
                    onClick={() => onAddDevice('switch', 4, 'gpon_ont')}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md border text-xs transition-colors cursor-pointer ${armedBtnClass(
                      isDeviceArmed('switch', 4, 'gpon_ont'),
                      'border-teal-500/30 hover:border-teal-500/60'
                    )}`}
                  >
                    <span className="flex items-center gap-2 font-medium min-w-0">
                      <Cpu className="w-3.5 h-3.5 text-teal-400 shrink-0" />
                      <span className="truncate">ONT / ONU</span>
                    </span>
                    <span className="text-[10px] font-mono text-teal-300 shrink-0 ml-1.5">
                      {isDeviceArmed('switch', 4, 'gpon_ont') ? '+ Клик' : 'FTTH · dBm'}
                    </span>
                  </button>
                </div>
              )}
            </div>

            {/* Category 3: Wireless Wi-Fi 802.11 & WLC */}
            <div className="rounded-md border border-slate-800/90 bg-slate-950/40 overflow-hidden">
              <button
                type="button"
                data-testid="device-cat-toggle-wireless"
                onClick={() => toggleCategory('wireless')}
                className="w-full flex items-center justify-between px-2.5 py-1.5 bg-slate-900/80 hover:bg-slate-800/80 text-[11px] font-semibold text-slate-200 transition-colors cursor-pointer"
              >
                <span className="flex items-center gap-1.5 truncate">
                  <Wifi className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                  <span className="truncate">Беспроводные Wi-Fi</span>
                </span>
                <span className="flex items-center gap-1 shrink-0">
                  <span className="text-[10px] font-mono text-slate-400">3</span>
                  {openCategories.wireless ? (
                    <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                  )}
                </span>
              </button>

              {openCategories.wireless && (
                <div className="p-1.5 space-y-1 border-t border-slate-800/70">
                  <button
                    type="button"
                    data-testid="add-wlc-btn"
                    onClick={() => onAddDevice('switch', 4, 'wlc')}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md border text-xs transition-colors cursor-pointer ${armedBtnClass(
                      isDeviceArmed('switch', 4, 'wlc')
                    )}`}
                  >
                    <span className="flex items-center gap-2 font-medium min-w-0">
                      <Server className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                      <span className="truncate">WLC 5520</span>
                    </span>
                    <span className="text-[10px] font-mono text-slate-400 shrink-0 ml-1.5">
                      {isDeviceArmed('switch', 4, 'wlc') ? '+ Клик' : 'CAPWAP'}
                    </span>
                  </button>

                  <button
                    type="button"
                    data-testid="add-wifi-ap-btn"
                    onClick={() => onAddDevice('switch', 6, 'wifi_ap')}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md border text-xs transition-colors cursor-pointer ${armedBtnClass(
                      isDeviceArmed('switch', 6, 'wifi_ap')
                    )}`}
                  >
                    <span className="flex items-center gap-2 font-medium min-w-0">
                      <Wifi className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                      <span className="truncate">Wi-Fi AP</span>
                    </span>
                    <span className="text-[10px] font-mono text-slate-400 shrink-0 ml-1.5">
                      {isDeviceArmed('switch', 6, 'wifi_ap') ? '+ Клик' : '802.11 AP'}
                    </span>
                  </button>

                  <button
                    type="button"
                    data-testid="add-soho-router-btn"
                    onClick={() => onAddDevice('router', 6, 'soho_wifi_router')}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md border text-xs transition-colors cursor-pointer ${armedBtnClass(
                      isDeviceArmed('router', 6, 'soho_wifi_router')
                    )}`}
                  >
                    <span className="flex items-center gap-2 font-medium min-w-0">
                      <Radio className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                      <span className="truncate">Wi-Fi Роутер</span>
                    </span>
                    <span className="text-[10px] font-mono text-slate-400 shrink-0 ml-1.5">
                      {isDeviceArmed('router', 6, 'soho_wifi_router') ? '+ Клик' : 'NAT+Wlan0'}
                    </span>
                  </button>
                </div>
              )}
            </div>

            {/* Category 4: Endpoints (PC, Server, Laptop, Smartphone) */}
            <div className="rounded-md border border-slate-800/90 bg-slate-950/40 overflow-hidden">
              <button
                type="button"
                data-testid="device-cat-toggle-endpoints"
                onClick={() => toggleCategory('endpoints')}
                className="w-full flex items-center justify-between px-2.5 py-1.5 bg-slate-900/80 hover:bg-slate-800/80 text-[11px] font-semibold text-slate-200 transition-colors cursor-pointer"
              >
                <span className="flex items-center gap-1.5 truncate">
                  <Monitor className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span className="truncate">Конечные устройства</span>
                </span>
                <span className="flex items-center gap-1 shrink-0">
                  <span className="text-[10px] font-mono text-slate-400">7</span>
                  {openCategories.endpoints ? (
                    <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                  )}
                </span>
              </button>

              {openCategories.endpoints && (
                <div className="p-1.5 space-y-1 border-t border-slate-800/70">
                  <button
                    type="button"
                    data-testid="add-pc-btn"
                    onClick={() => onAddDevice('pc')}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md border text-xs transition-colors cursor-pointer ${armedBtnClass(
                      isDeviceArmed('pc', 6, undefined)
                    )}`}
                  >
                    <span className="flex items-center gap-2 font-medium min-w-0">
                      <Monitor className="w-3.5 h-3.5 text-slate-200 shrink-0" />
                      <span className="truncate">Хост (PC)</span>
                    </span>
                    <span className="text-[10px] font-mono text-slate-400 shrink-0 ml-1.5">
                      {isDeviceArmed('pc', 6, undefined) ? '+ Клик' : 'Eth0'}
                    </span>
                  </button>

                  <button
                    type="button"
                    data-testid="add-ip-phone-btn"
                    onClick={() => onAddDevice('pc', 2, 'ip_phone')}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md border text-xs transition-colors cursor-pointer ${armedBtnClass(
                      isDeviceArmed('pc', 2, 'ip_phone')
                    )}`}
                  >
                    <span className="flex items-center gap-2 font-medium min-w-0">
                      <PhoneCall className="w-3.5 h-3.5 text-fuchsia-400 shrink-0" />
                      <span className="truncate">IP-Телефон</span>
                    </span>
                    <span className="text-[10px] font-mono text-slate-400 shrink-0 ml-1.5">
                      {isDeviceArmed('pc', 2, 'ip_phone') ? '+ Клик' : 'PoE · SIP'}
                    </span>
                  </button>

                  <button
                    type="button"
                    data-testid="add-ip-camera-btn"
                    onClick={() => onAddDevice('pc', 1, 'ip_camera')}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md border text-xs transition-colors cursor-pointer ${armedBtnClass(
                      isDeviceArmed('pc', 1, 'ip_camera')
                    )}`}
                  >
                    <span className="flex items-center gap-2 font-medium min-w-0">
                      <Camera className="w-3.5 h-3.5 text-teal-400 shrink-0" />
                      <span className="truncate">IP-Камера (PoE)</span>
                    </span>
                    <span className="text-[10px] font-mono text-slate-400 shrink-0 ml-1.5">
                      {isDeviceArmed('pc', 1, 'ip_camera') ? '+ Клик' : 'RTSP · 9.5W'}
                    </span>
                  </button>

                  <button
                    type="button"
                    data-testid="add-nvr-btn"
                    onClick={() => onAddDevice('server', 1, 'nvr')}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md border text-xs transition-colors cursor-pointer ${armedBtnClass(
                      isDeviceArmed('server', 1, 'nvr')
                    )}`}
                  >
                    <span className="flex items-center gap-2 font-medium min-w-0">
                      <Video className="w-3.5 h-3.5 text-teal-300 shrink-0" />
                      <span className="truncate">Видеорегистратор NVR</span>
                    </span>
                    <span className="text-[10px] font-mono text-slate-400 shrink-0 ml-1.5">
                      {isDeviceArmed('server', 1, 'nvr') ? '+ Клик' : 'NVR · 16TB'}
                    </span>
                  </button>

                  <button
                    type="button"
                    data-testid="add-server-btn"
                    onClick={() => onAddDevice('server')}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md border text-xs transition-colors cursor-pointer ${armedBtnClass(
                      isDeviceArmed('server', 6, undefined)
                    )}`}
                  >
                    <span className="flex items-center gap-2 font-medium min-w-0">
                      <Server className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      <span className="truncate">Сервер (L7)</span>
                    </span>
                    <span className="text-[10px] font-mono text-slate-400 shrink-0 ml-1.5">
                      {isDeviceArmed('server', 6, undefined) ? '+ Клик' : 'HTTP/SIP'}
                    </span>
                  </button>

                  <button
                    type="button"
                    data-testid="add-laptop-btn"
                    onClick={() => onAddDevice('pc', 6, 'laptop')}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md border text-xs transition-colors cursor-pointer ${armedBtnClass(
                      isDeviceArmed('pc', 6, 'laptop')
                    )}`}
                  >
                    <span className="flex items-center gap-2 font-medium min-w-0">
                      <Laptop className="w-3.5 h-3.5 text-violet-400 shrink-0" />
                      <span className="truncate">Ноутбук</span>
                    </span>
                    <span className="text-[10px] font-mono text-slate-400 shrink-0 ml-1.5">
                      {isDeviceArmed('pc', 6, 'laptop') ? '+ Клик' : 'Wlan0'}
                    </span>
                  </button>

                  <button
                    type="button"
                    data-testid="add-smartphone-btn"
                    onClick={() => onAddDevice('pc', 6, 'smartphone')}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md border text-xs transition-colors cursor-pointer ${armedBtnClass(
                      isDeviceArmed('pc', 6, 'smartphone')
                    )}`}
                  >
                    <span className="flex items-center gap-2 font-medium min-w-0">
                      <Smartphone className="w-3.5 h-3.5 text-violet-400 shrink-0" />
                      <span className="truncate">Смартфон</span>
                    </span>
                    <span className="text-[10px] font-mono text-slate-400 shrink-0 ml-1.5">
                      {isDeviceArmed('pc', 6, 'smartphone') ? '+ Клик' : 'Wlan0'}
                    </span>
                  </button>
                </div>
              )}
            </div>

            <button
              type="button"
              data-testid="add-zone-btn"
              onClick={onAddZone}
              className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md border text-xs transition-colors cursor-pointer ${armedBtnClass(
                pendingPlacement?.kind === 'zone'
              )}`}
            >
              <span className="flex items-center gap-2 font-medium">
                <Layers className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                <span>Зона подсети</span>
              </span>
              <span className="text-[10px] font-mono text-slate-400">
                {pendingPlacement?.kind === 'zone' ? '+ Клик' : '+VLAN'}
              </span>
            </button>
          </div>
        </div>

        {/* Section 3: Collapsible Lab Scenarios Accordion (All 10 Presets) */}
        <div className="pt-2.5 border-t border-slate-800 space-y-2">
          {onOpenCoreDiagnostics && (
            <button
              type="button"
              data-testid="run-core-diagnostics-btn"
              onClick={onOpenCoreDiagnostics}
              className="w-full flex items-center justify-between px-2.5 py-2 rounded-md bg-emerald-950/80 hover:bg-emerald-800 border border-emerald-500/50 text-xs font-semibold text-emerald-200 hover:text-white transition-colors cursor-pointer"
            >
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>Автотест ядра (L1–L7)</span>
              </span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-900/90 text-emerald-300">
                17 тестов
              </span>
            </button>
          )}

          {/* Active Preset 1-Click Feature Test Scenarios */}
          {activePreset && activePreset.testScenarios && activePreset.testScenarios.length > 0 && onRunPresetTest && (
            <div className="p-2 rounded-md bg-slate-950/90 border border-sky-500/30 space-y-1.5">
              <div className="flex items-center justify-between text-[11px] font-semibold text-sky-300">
                <span>Тесты стенда ({activePreset.testScenarios.length})</span>
                <span className="text-[9px] font-mono text-slate-400">1-клик запуск</span>
              </div>
              <div className="space-y-1">
                {activePreset.testScenarios.map((sc) => (
                  <button
                    key={sc.id}
                    type="button"
                    data-testid={`preset-test-btn-${sc.id}`}
                    onClick={() => onRunPresetTest(sc)}
                    className={`w-full text-left p-1.5 rounded border text-[11px] transition-colors cursor-pointer ${
                      sc.expectedOutcome === 'blocked' || sc.expectedOutcome === 'drop'
                        ? 'bg-red-950/35 hover:bg-red-900/50 border-red-500/40 text-red-200'
                        : 'bg-slate-900/90 hover:bg-slate-800 border-slate-800 text-slate-200'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1 font-medium">
                      <span className="truncate">{sc.title}</span>
                      <span
                        className={`px-1 py-0.2 rounded text-[9px] font-mono font-bold shrink-0 ${
                          sc.expectedOutcome === 'blocked' || sc.expectedOutcome === 'drop'
                            ? 'bg-red-900/80 text-red-200'
                            : sc.protocolBadge === 'OSPF'
                            ? 'bg-lime-900/80 text-lime-300'
                            : sc.protocolBadge === 'RIP'
                            ? 'bg-amber-900/80 text-amber-300'
                            : sc.protocolBadge === 'CAPWAP'
                            ? 'bg-cyan-900/90 text-cyan-200'
                            : sc.protocolBadge === 'FIREWALL'
                            ? 'bg-rose-900/90 text-rose-200'
                            : sc.protocolBadge === 'IPSEC'
                            ? 'bg-emerald-900/90 text-emerald-200'
                            : sc.protocolBadge === 'STACK'
                            ? 'bg-amber-900/90 text-amber-200'
                            : sc.protocolBadge === 'VOIP' || sc.protocolBadge === 'POE'
                            ? 'bg-fuchsia-900/90 text-fuchsia-200'
                            : sc.protocolBadge === 'RTSP'
                            ? 'bg-teal-900/90 text-teal-200'
                            : sc.protocolBadge === 'BGP' || sc.protocolBadge === 'WAN'
                            ? 'bg-orange-900/90 text-orange-200'
                            : sc.protocolBadge === 'GPON'
                            ? 'bg-emerald-900/90 text-emerald-200'
                            : 'bg-sky-900/80 text-sky-300'
                        }`}
                      >
                        {sc.protocolBadge}
                      </span>
                    </div>
                    <div className="text-[10px] text-slate-400 leading-tight mt-0.5 line-clamp-2">
                      {sc.subtitle}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          <button
            type="button"
            data-testid="toggle-presets-accordion-btn"
            onClick={() => setPresetsOpen((o) => !o)}
            className="w-full flex items-center justify-between py-1 text-xs font-semibold text-slate-300 hover:text-white cursor-pointer"
          >
            <span className="flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-sky-400" />
              <span>Лабораторные стенды ({TOPOLOGY_PRESETS.length})</span>
            </span>
            {presetsOpen ? (
              <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
            )}
          </button>

          {presetsOpen && (
            <div className="space-y-1.5 mt-1">
              {TOPOLOGY_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  data-testid={`preset-btn-${preset.id}`}
                  onClick={() => onLoadPreset(preset.id)}
                  className={`w-full text-left px-2.5 py-1.5 rounded-md border text-xs transition-colors cursor-pointer ${
                    activePresetId === preset.id
                      ? 'bg-sky-500/15 border-sky-500/40 text-sky-200 font-medium'
                      : 'bg-slate-950/60 border-slate-800 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  <div className="leading-snug">{preset.name}</div>
                  <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                    {preset.shortTag || `${preset.nodes.length} узлов`}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Bottom Project Persistence Actions */}
      <div className="pt-2.5 border-t border-slate-800 space-y-1.5">
        <div className="grid grid-cols-2 gap-1.5">
          <button
            onClick={onExportJson}
            className="flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Экспорт</span>
          </button>

          <label className="flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded transition-colors cursor-pointer whitespace-nowrap shrink-0">
            <Upload className="w-3.5 h-3.5" />
            <span>Импорт</span>
            <input
              type="file"
              accept=".json"
              onChange={onImportJson}
              className="hidden"
            />
          </label>
        </div>

        <button
          onClick={onClearCanvas}
          className="w-full px-2 py-1 text-[11px] font-medium text-slate-400 hover:text-red-300 hover:bg-red-950/40 border border-slate-800 rounded transition-colors whitespace-nowrap shrink-0"
        >
          Очистить холст
        </button>
      </div>
    </aside>
  );
};
