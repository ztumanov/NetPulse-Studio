import React from 'react';
import { SimulationStep } from '../network/types';
import { X, ArrowRight, CheckCircle2, AlertTriangle, Radio, Layers, Globe } from 'lucide-react';

interface PduInspectorModalProps {
  step: SimulationStep | null;
  onClose: () => void;
}

export const PduInspectorModal: React.FC<PduInspectorModalProps> = ({ step, onClose }) => {
  const [activeTab, setActiveTab] = React.useState<'osi' | 'pdu'>('osi');

  if (!step) return null;

  const statusBadge = () => {
    switch (step.status) {
      case 'delivered':
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-mono text-emerald-400">
            <CheckCircle2 className="w-3.5 h-3.5" /> ● DELIVERED
          </span>
        );
      case 'forwarded':
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-mono text-sky-400">
            <ArrowRight className="w-3.5 h-3.5" /> ◆ FORWARDED
          </span>
        );
      case 'broadcast':
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-mono text-amber-400">
            <Radio className="w-3.5 h-3.5" /> ▲ BROADCAST / FLOOD
          </span>
        );
      case 'dropped':
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-mono text-red-400">
            <AlertTriangle className="w-3.5 h-3.5" /> ✕ DROPPED
          </span>
        );
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-xs p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pdu-modal-title"
    >
      <div className="w-full max-w-4xl bg-slate-900 border border-slate-700 rounded-lg shadow-2xl overflow-hidden flex flex-col max-h-[88vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800 bg-slate-900">
          <div className="flex items-center gap-3">
            <Layers className="w-5 h-5 text-sky-400 shrink-0" />
            <div>
              <h2 id="pdu-modal-title" className="text-base font-semibold text-slate-100">
                Инспектор пакета PDU — Шаг #{step.stepIndex} ({step.protocol})
              </h2>
              <div className="flex items-center gap-2 text-xs text-slate-400 font-mono">
                <span>
                  {step.fromNodeName}:{step.fromPortName}
                </span>
                <span>→</span>
                <span>
                  {step.toNodeName}:{step.toPortName}
                </span>
                <span>·</span>
                {statusBadge()}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Закрыть инспектор PDU"
            className="p-1.5 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-md transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Sub-navigation tabs */}
        <div className="flex items-center justify-between px-5 py-2.5 bg-slate-950/60 border-b border-slate-800">
          <div className="flex items-center gap-1 p-1 bg-slate-900 border border-slate-800 rounded-md">
            <button
              onClick={() => setActiveTab('osi')}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'osi'
                  ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Модель OSI (L1–L7)
            </button>
            <button
              onClick={() => setActiveTab('pdu')}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'pdu'
                  ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Структура заголовков PDU (Inbound / Outbound)
            </button>
          </div>
          <div className="text-xs text-slate-400 font-mono">
            Время симуляции: {step.timestampMs} мс
          </div>
        </div>

        {/* Body */}
        <div className="p-5 overflow-y-auto space-y-5 flex-1">
          {/* Decision Banner */}
          <div className="p-3.5 rounded-md bg-slate-950 border border-slate-800">
            <div className="text-xs text-slate-400 mb-1">Решение сетевого узла ({step.toNodeName}):</div>
            <div className="text-sm font-medium text-slate-100">{step.decisionTitle}</div>
          </div>

          {activeTab === 'osi' ? (
            <div className="space-y-4">
              {/* L7 Application Layer Highlight Banner when present */}
              {step.outboundPdu.l7 && (
                <div className="p-3.5 rounded-md bg-indigo-950/30 border border-indigo-500/40 space-y-2">
                  <div className="flex items-center gap-2 text-xs font-semibold text-indigo-300">
                    <Globe className="w-4 h-4 shrink-0" />
                    <span>
                      Layer 7 Application ({step.outboundPdu.l7.appProtocol}): {step.outboundPdu.l7.headline}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-1 text-xs font-mono">
                    {Object.entries(step.outboundPdu.l7.fields).map(([key, val]) => (
                      <div key={key} className="p-2 rounded bg-slate-950/80 border border-slate-800">
                        <div className="text-[10px] text-slate-400">{key}</div>
                        <div className="text-slate-100 truncate mt-0.5">{val}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Inbound vs Outbound OSI Layers */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Inbound PDU Summary */}
                <div className="border border-slate-800 rounded-md bg-slate-950/50 p-4">
                  <div className="text-xs font-semibold text-slate-300 pb-2.5 mb-3 border-b border-slate-800 flex items-center justify-between">
                    <span>Входящий PDU (Отправитель: {step.fromNodeName})</span>
                    <span className="font-mono text-slate-400">{step.fromPortName}</span>
                  </div>
                  <div className="space-y-2.5 text-xs font-mono">
                    <div className="p-2.5 rounded bg-slate-900 border border-slate-800/80">
                      <div className="text-sky-400 font-semibold mb-1">
                        Layer 4 ({step.inboundPdu.l4.type})
                        {step.inboundPdu.l4.srcPort !== undefined &&
                          ` · Port ${step.inboundPdu.l4.srcPort} → ${step.inboundPdu.l4.dstPort}`}
                      </div>
                      <div className="text-slate-300">{step.inboundPdu.l4.summary}</div>
                    </div>
                    <div className="p-2.5 rounded bg-slate-900 border border-slate-800/80">
                      <div className="text-emerald-400 font-semibold mb-1">
                        Layer 3 ({step.inboundPdu.l3.headerType})
                      </div>
                      <div className="grid grid-cols-2 gap-1 text-slate-300">
                        <span>Src IP: {step.inboundPdu.l3.srcIp}</span>
                        <span>Dst IP: {step.inboundPdu.l3.dstIp}</span>
                        <span>TTL: {step.inboundPdu.l3.ttl}</span>
                        <span>Proto: {step.inboundPdu.l3.protocol}</span>
                      </div>
                    </div>
                    <div className="p-2.5 rounded bg-slate-900 border border-slate-800/80">
                      <div className="text-amber-400 font-semibold mb-1">
                        Layer 2 ({step.inboundPdu.l2.headerType})
                      </div>
                      <div className="space-y-0.5 text-slate-300">
                        <div>Src MAC: {step.inboundPdu.l2.srcMac}</div>
                        <div>Dst MAC: {step.inboundPdu.l2.dstMac}</div>
                        <div>
                          EtherType: {step.inboundPdu.l2.etherType}{' '}
                          {step.inboundPdu.l2.vlanTag !== null
                            ? `· 802.1Q VLAN ${step.inboundPdu.l2.vlanTag}`
                            : '· Untagged'}
                        </div>
                      </div>
                    </div>
                    <div className="p-2.5 rounded bg-slate-900 border border-slate-800/80">
                      <div className="text-slate-400 font-semibold mb-1">Layer 1 (Physical Ports)</div>
                      <div className="text-slate-300">
                        In: {step.inboundPdu.l1.inPort} → Out: {step.inboundPdu.l1.outPort}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Outbound PDU Summary */}
                <div className="border border-slate-800 rounded-md bg-slate-950/50 p-4">
                  <div className="text-xs font-semibold text-slate-300 pb-2.5 mb-3 border-b border-slate-800 flex items-center justify-between">
                    <span>Обработка на узле ({step.toNodeName})</span>
                    <span className="font-mono text-slate-400">{step.toPortName}</span>
                  </div>
                  <div className="space-y-2.5 text-xs font-mono">
                    <div className="p-2.5 rounded bg-slate-900 border border-slate-800/80">
                      <div className="text-sky-400 font-semibold mb-1">
                        Layer 4 ({step.outboundPdu.l4.type})
                        {step.outboundPdu.l4.srcPort !== undefined &&
                          ` · Port ${step.outboundPdu.l4.srcPort} → ${step.outboundPdu.l4.dstPort}`}
                      </div>
                      <div className="text-slate-300">{step.outboundPdu.l4.summary}</div>
                    </div>
                    <div className="p-2.5 rounded bg-slate-900 border border-slate-800/80">
                      <div className="text-emerald-400 font-semibold mb-1">
                        Layer 3 ({step.outboundPdu.l3.headerType})
                      </div>
                      <div className="grid grid-cols-2 gap-1 text-slate-300">
                        <span>Src IP: {step.outboundPdu.l3.srcIp}</span>
                        <span>Dst IP: {step.outboundPdu.l3.dstIp}</span>
                        <span>TTL: {step.outboundPdu.l3.ttl}</span>
                        <span>Proto: {step.outboundPdu.l3.protocol}</span>
                      </div>
                    </div>
                    <div className="p-2.5 rounded bg-slate-900 border border-slate-800/80">
                      <div className="text-amber-400 font-semibold mb-1">
                        Layer 2 ({step.outboundPdu.l2.headerType})
                      </div>
                      <div className="space-y-0.5 text-slate-300">
                        <div>Src MAC: {step.outboundPdu.l2.srcMac}</div>
                        <div>Dst MAC: {step.outboundPdu.l2.dstMac}</div>
                        <div>
                          EtherType: {step.outboundPdu.l2.etherType}{' '}
                          {step.outboundPdu.l2.vlanTag !== null
                            ? `· 802.1Q VLAN ${step.outboundPdu.l2.vlanTag}`
                            : '· Untagged'}
                        </div>
                      </div>
                    </div>
                    <div className="p-2.5 rounded bg-slate-900 border border-slate-800/80">
                      <div className="text-slate-400 font-semibold mb-1">Layer 1 (Physical Action)</div>
                      <div className="text-slate-300">
                        In: {step.outboundPdu.l1.inPort} → Out: {step.outboundPdu.l1.outPort}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Step-by-step OSI Processing Log */}
              <div className="border border-slate-800 rounded-md bg-slate-950/60 p-4">
                <h3 className="text-xs font-semibold text-slate-300 mb-3">
                  Пошаговый алгоритм обработки кадра на устройстве {step.toNodeName}:
                </h3>
                <div className="space-y-2.5">
                  {step.osiActions.map((act, idx) => (
                    <div
                      key={idx}
                      className="flex items-start gap-3 p-2.5 rounded bg-slate-900/90 border border-slate-800/80 text-xs"
                    >
                      <span className="font-mono font-semibold text-sky-400 shrink-0 w-8">
                        [{act.layer}]
                      </span>
                      <div className="space-y-0.5">
                        <div className="font-medium text-slate-200">{act.title}</div>
                        <div className="text-slate-400 leading-relaxed">{act.detail}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            /* Detailed Byte-Level Frame Structure */
            <div className="space-y-4 font-mono text-xs">
              <div className="border border-slate-800 rounded-md overflow-hidden">
                <div className="bg-slate-800/70 px-3.5 py-2 text-slate-200 font-semibold">
                  Ethernet II / IEEE 802.1Q Frame Format (Канальный уровень L2)
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-y divide-slate-800 bg-slate-950">
                  <div className="p-3">
                    <div className="text-slate-500 text-[11px]">Preamble & SFD (8 B)</div>
                    <div className="text-slate-200 mt-1">10101010...10101011</div>
                  </div>
                  <div className="p-3">
                    <div className="text-slate-500 text-[11px]">Destination MAC (6 B)</div>
                    <div className="text-amber-300 mt-1">{step.outboundPdu.l2.dstMac}</div>
                  </div>
                  <div className="p-3">
                    <div className="text-slate-500 text-[11px]">Source MAC (6 B)</div>
                    <div className="text-sky-300 mt-1">{step.outboundPdu.l2.srcMac}</div>
                  </div>
                  <div className="p-3">
                    <div className="text-slate-500 text-[11px]">802.1Q Tag / EtherType</div>
                    <div className="text-emerald-300 mt-1">
                      {step.outboundPdu.l2.vlanTag !== null
                        ? `VLAN ${step.outboundPdu.l2.vlanTag} (${step.outboundPdu.l2.etherType})`
                        : step.outboundPdu.l2.etherType}
                    </div>
                  </div>
                </div>
              </div>

              <div className="border border-slate-800 rounded-md overflow-hidden">
                <div className="bg-slate-800/70 px-3.5 py-2 text-slate-200 font-semibold">
                  {step.outboundPdu.l3.headerType} Header (Сетевой уровень L3)
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-y divide-slate-800 bg-slate-950">
                  <div className="p-3">
                    <div className="text-slate-500 text-[11px]">Protocol</div>
                    <div className="text-slate-200 mt-1">{step.outboundPdu.l3.protocol}</div>
                  </div>
                  <div className="p-3">
                    <div className="text-slate-500 text-[11px]">Time to Live (TTL)</div>
                    <div className="text-slate-200 mt-1">{step.outboundPdu.l3.ttl} hops</div>
                  </div>
                  <div className="p-3">
                    <div className="text-slate-500 text-[11px]">Source IPv4 Address</div>
                    <div className="text-sky-300 mt-1">{step.outboundPdu.l3.srcIp}</div>
                  </div>
                  <div className="p-3">
                    <div className="text-slate-500 text-[11px]">Destination IPv4 Address</div>
                    <div className="text-emerald-300 mt-1">{step.outboundPdu.l3.dstIp}</div>
                  </div>
                </div>
              </div>

              <div className="border border-slate-800 rounded-md overflow-hidden">
                <div className="bg-slate-800/70 px-3.5 py-2 text-slate-200 font-semibold">
                  L4 Transport & L7 Application Payload ({step.outboundPdu.l4.type})
                </div>
                <div className="p-3.5 bg-slate-950 text-slate-300 space-y-1.5">
                  <div>Summary: {step.outboundPdu.l4.summary}</div>
                  {step.outboundPdu.l4.srcPort !== undefined && (
                    <div className="text-sky-300">
                      Transport Ports: Source Port {step.outboundPdu.l4.srcPort} → Destination Port{' '}
                      {step.outboundPdu.l4.dstPort}
                    </div>
                  )}
                  {step.outboundPdu.l7 && (
                    <div className="pt-2 border-t border-slate-800 text-indigo-300">
                      L7 [{step.outboundPdu.l7.appProtocol}]: {step.outboundPdu.l7.headline}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-800 bg-slate-900 flex items-center justify-between">
          <span className="text-xs text-slate-400">
            Используйте кнопки «Назад» и «Вперёд» на панели симуляции для пошагового отслеживания пакетов.
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            Закрыть окно
          </button>
        </div>
      </div>
    </div>
  );
};
