import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { get, post, patch, del, api } from '../api.js';
import { getSocket } from '../socket.js';
import { useRouter } from '../router.jsx';
import { useAuth, useToast, hasRole } from '../store.jsx';
import { Avatar, Badge, Button, Chips, Empty, Loading, Switch, Menu, Confirm, ChannelTag, useMediaQuery, MOBILE_QUERY, fmtTime, fmtDateTime, fmtPhone, CONV_STATUS, STAGES } from '../components/ui.jsx';
import { MessageBubble } from '../components/MessageBubble.jsx';
import { TemplatePicker } from '../components/TemplatePicker.jsx';
import { I } from '../components/Icons.jsx';

const FILTERS = [
  { value: 'all', label: 'Todas' },
  { value: 'unread', label: 'No leídas' },
  { value: 'mine', label: 'Mías' },
  { value: 'unassigned', label: 'Sin asignar' },
  { value: 'pending', label: 'Pendientes' },
  { value: 'bot', label: 'Bot activo' },
  { value: 'closed', label: 'Cerradas' },
];

function filterQuery(filter, userId) {
  switch (filter) {
    case 'unread': return 'unread=true';
    case 'mine': return `assignedUserId=${userId}`;
    case 'unassigned': return 'unassigned=true&status=open';
    case 'pending': return 'status=pending';
    case 'bot': return 'botActive=true';
    case 'closed': return 'status=closed';
    default: return '';
  }
}

function dayKey(value) {
  return new Date(value).toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
}

/* ========================================================================== */
export default function Inbox({ params }) {
  const { user } = useAuth();
  const { navigate } = useRouter();
  const toast = useToast();
  const conversationId = params.conversationId ?? null;

  const [filter, setFilter] = useState('all');
  const [channel, setChannel] = useState(''); // '' = todos los números · 'none' = sin número · id
  const [channels, setChannels] = useState({ items: [], botsForAll: [], withoutNumber: 0 });
  const [query, setQuery] = useState('');
  const [list, setList] = useState({ items: [], total: 0, loading: true });
  const [current, setCurrent] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [notes, setNotes] = useState([]);
  const [users, setUsers] = useState([]);
  const [quickReplies, setQuickReplies] = useState([]);
  const [showPanel, setShowPanel] = useState(true);   // escritorio: tercera columna
  const [panelMobile, setPanelMobile] = useState(false); // móvil: info del contacto a pantalla completa
  const [bots, setBots] = useState([]);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [confirm, setConfirm] = useState(null); // { kind: 'delete' | 'clear' | 'bulk', ids, name }
  const [busy, setBusy] = useState(false);
  const isMobile = useMediaQuery(MOBILE_QUERY);

  /* ---------------- lista ---------------- */
  const loadList = useCallback(async () => {
    const qs = [filterQuery(filter, user.id), channel ? `integrationId=${encodeURIComponent(channel)}` : '', query ? `q=${encodeURIComponent(query)}` : '', 'limit=60'].filter(Boolean).join('&');
    try {
      const data = await get(`/api/conversations?${qs}`);
      setList({ items: data.items, total: data.total, loading: false });
    } catch (err) {
      toast(err.message, { error: true });
      setList((s) => ({ ...s, loading: false }));
    }
  }, [filter, channel, query, user.id, toast]);

  useEffect(() => { loadList(); }, [loadList]);

  const loadChannels = useCallback(() => {
    get('/api/inbox/channels').then((d) => {
      setChannels(d);
      // Todos los chatbots activos (por número o para todos): sirve para saber si hay Bot Gateway.
      const all = new Map();
      for (const i of d.items) for (const b of i.bots) all.set(b.id, b);
      for (const b of d.botsForAll) all.set(b.id, b);
      setBots([...all.values()]);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    // Datos auxiliares que cambian poco.
    get('/api/quick-replies').then((d) => setQuickReplies(d.items)).catch(() => {});
    loadChannels();
    if (hasRole(user, 'admin')) {
      get('/api/users').then((d) => setUsers(d.items.filter((u) => u.active))).catch(() => {});
    }
  }, [user, loadChannels]);

  /* ---------------- hilo ---------------- */
  const loadThread = useCallback(async (id) => {
    setLoadingThread(true);
    try {
      const [conv, msgs, nts] = await Promise.all([
        get(`/api/conversations/${id}`),
        get(`/api/conversations/${id}/messages?limit=100`),
        get(`/api/conversations/${id}/notes`),
      ]);
      setCurrent(conv);
      setMessages(msgs.items);
      setNotes(nts.items);
      if (conv.unreadCount > 0) {
        post(`/api/conversations/${id}/read`).then(() => {
          setList((s) => ({ ...s, items: s.items.map((c) => (c.id === id ? { ...c, unreadCount: 0 } : c)) }));
        }).catch(() => {});
      }
    } catch (err) {
      toast(err.message, { error: true });
      navigate('/inbox', { replace: true });
    } finally {
      setLoadingThread(false);
    }
  }, [toast, navigate]);

  useEffect(() => {
    setPanelMobile(false);
    if (conversationId) loadThread(conversationId);
    else { setCurrent(null); setMessages([]); setNotes([]); }
  }, [conversationId, loadThread]);

  /* ---------------- tiempo real ---------------- */
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return undefined;
    let timer = null;
    const refreshList = () => { clearTimeout(timer); timer = setTimeout(loadList, 250); };

    const onCreated = (message) => {
      if (message.conversationId === conversationId) {
        setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
        if (message.direction === 'inbound') post(`/api/conversations/${conversationId}/read`).catch(() => {});
      }
      refreshList();
    };
    const onStatus = (payload) => {
      setMessages((prev) => prev.map((m) => (m.id === payload.id ? { ...m, ...payload } : m)));
    };
    const onConv = (payload) => {
      if (payload.id === conversationId) setCurrent((c) => (c ? { ...c, ...payload } : c));
      refreshList();
    };
    const onDeleted = (payload) => {
      setList((s) => ({ ...s, items: s.items.filter((c) => c.id !== payload.id), total: Math.max(0, s.total - 1) }));
      if (payload.id === conversationId) navigate('/inbox', { replace: true });
    };
    const onCleared = (payload) => {
      if (payload.id === conversationId) setMessages([]);
      refreshList();
    };
    socket.on('message:created', onCreated);
    socket.on('message:status', onStatus);
    socket.on('conversation:updated', onConv);
    socket.on('conversation:deleted', onDeleted);
    socket.on('conversation:cleared', onCleared);
    return () => {
      clearTimeout(timer);
      socket.off('message:created', onCreated);
      socket.off('message:status', onStatus);
      socket.off('conversation:updated', onConv);
      socket.off('conversation:deleted', onDeleted);
      socket.off('conversation:cleared', onCleared);
    };
  }, [conversationId, loadList, navigate]);

  /* ---------------- acciones ---------------- */
  async function updateConversation(data) {
    const updated = await patch(`/api/conversations/${current.id}`, data);
    setCurrent(updated);
    setList((s) => ({ ...s, items: s.items.map((c) => (c.id === updated.id ? updated : c)) }));
    return updated;
  }

  async function toggleBot() {
    const action = current.botActive ? 'pause' : 'resume';
    const r = await post(`/api/conversations/${current.id}/bot/${action}`);
    setCurrent((c) => ({ ...c, botActive: r.botActive, botPausedUntil: r.botPausedUntil }));
    toast(r.botActive ? 'Bot reactivado en esta conversación' : 'Bot pausado: el CRM no dejará que responda aquí');
  }

  const nameOf = (c) => c?.contact?.name || fmtPhone(c?.contact?.waId) || 'este chat';

  async function runConfirm() {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === 'clear') {
        const r = await post(`/api/conversations/${confirm.ids[0]}/clear`);
        if (confirm.ids[0] === conversationId) { setMessages([]); setCurrent((c) => (c ? { ...c, lastMessagePreview: null } : c)); }
        setList((s) => ({ ...s, items: s.items.map((c) => (c.id === confirm.ids[0] ? { ...c, lastMessagePreview: null, unreadCount: 0 } : c)) }));
        toast(`Chat vaciado (${r.deletedMessages} mensajes)`);
      } else {
        const r = confirm.ids.length === 1
          ? await del(`/api/conversations/${confirm.ids[0]}`)
          : await post('/api/conversations/bulk-delete', { ids: confirm.ids });
        const gone = new Set(confirm.ids);
        setList((s) => ({ ...s, items: s.items.filter((c) => !gone.has(c.id)), total: Math.max(0, s.total - r.deleted) }));
        toast(r.deleted === 1 ? 'Chat eliminado' : `${r.deleted} chats eliminados`);
        if (gone.has(conversationId)) navigate('/inbox', { replace: true });
        setSelectMode(false); setSelected(new Set());
      }
      setConfirm(null);
    } catch (err) {
      toast(err.message, { error: true });
    } finally { setBusy(false); }
  }

  function toggleSelected(id) {
    setSelected((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }
  function startSelect(id) {
    setSelectMode(true);
    setSelected(new Set(id ? [id] : []));
  }
  function exitSelect() { setSelectMode(false); setSelected(new Set()); }

  const canWrite = hasRole(user, 'agent');
  const showList = !conversationId;
  const mobileView = !conversationId ? 'list' : panelMobile ? 'contact' : 'thread';
  const panelVisible = Boolean(current) && (isMobile ? panelMobile : showPanel);

  return (
    <div className={`inbox ${!isMobile && showPanel && current ? 'show-panel' : 'no-panel'} mobile-${mobileView}`}>
      {/* ------------------------------------------------ lista */}
      <section className={`pane conv-list ${showList ? '' : 'hide-mobile'}`}>
        {selectMode ? (
          <div className="pane-head select-head">
            <div className="row between">
              <div className="row">
                <Button variant="ghost" className="icon" onClick={exitSelect} aria-label="Cancelar selección"><I.close /></Button>
                <strong>{selected.size} seleccionada{selected.size === 1 ? '' : 's'}</strong>
              </div>
              <div className="row">
                <Button size="sm" onClick={() => setSelected(new Set(list.items.map((c) => c.id)))}>Todas</Button>
                <Button size="sm" variant="danger" disabled={selected.size === 0} onClick={() => setConfirm({ kind: 'bulk', ids: [...selected] })}><I.trash /> Eliminar</Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="pane-head">
            <div className="row between">
              <h2>Bandeja</h2>
              <div className="row">
                <span className="badge">{list.total}</span>
                {canWrite ? (
                  <Menu
                    trigger={<Button variant="ghost" className="icon" aria-label="Opciones de la bandeja"><I.more /></Button>}
                    items={[
                      { label: 'Seleccionar chats', icon: <I.checkSquare />, onClick: () => startSelect(null), disabled: list.items.length === 0 },
                      { label: 'Actualizar', icon: <I.refresh />, onClick: loadList },
                    ]}
                  />
                ) : null}
              </div>
            </div>
            <input id="inbox-search" className="input" type="search" placeholder="Buscar por nombre o número" value={query} onChange={(e) => setQuery(e.target.value)} />
            {channels.items.length > 1 || channels.withoutNumber > 0 ? (
              <div className="channel-filter">
                <select id="inbox-channel" className="select" value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Filtrar por número o chatbot">
                  <option value="">Todos los números y chatbots</option>
                  {channels.items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {[i.bots.map((b) => b.name).join(' + ') || null, i.verifiedName, i.displayPhoneNumber].filter(Boolean).join(' · ')}{i.active ? '' : ' (desactivado)'}
                    </option>
                  ))}
                  {channels.withoutNumber > 0 ? <option value="none">Sin número asignado ({channels.withoutNumber})</option> : null}
                </select>
              </div>
            ) : null}
            <Chips value={filter} onChange={setFilter} items={FILTERS} />
          </div>
        )}
        <div className="pane-scroll">
          {list.loading ? <Loading /> : null}
          {!list.loading && list.items.length === 0 ? (
            <Empty title="Sin conversaciones">Cuando un cliente escriba a un número conectado, aparecerá aquí.</Empty>
          ) : null}
          {list.items.map((c) => (
            <ConversationRow
              key={c.id}
              conversation={c}
              active={c.id === conversationId}
              selectMode={selectMode}
              selected={selected.has(c.id)}
              canWrite={canWrite}
              onClick={() => (selectMode ? toggleSelected(c.id) : navigate(`/inbox/${c.id}`))}
              onLongPress={() => canWrite && !selectMode && startSelect(c.id)}
              onClear={() => setConfirm({ kind: 'clear', ids: [c.id], name: nameOf(c) })}
              onDelete={() => setConfirm({ kind: 'delete', ids: [c.id], name: nameOf(c) })}
              onSelect={() => startSelect(c.id)}
            />
          ))}
        </div>
      </section>

      {/* ------------------------------------------------ hilo */}
      <section className={`pane thread ${showList ? 'hide-mobile' : ''}`}>
        {!conversationId ? (
          <Empty title="Elige una conversación" icon={<I.inbox />}>Los mensajes nuevos llegan en tiempo real.</Empty>
        ) : loadingThread || !current ? (
          <Loading />
        ) : (
          <Thread
            conversation={current}
            messages={messages}
            onBack={() => navigate('/inbox')}
            onTogglePanel={() => (isMobile ? setPanelMobile(true) : setShowPanel((v) => !v))}
            onToggleBot={toggleBot}
            onClear={() => setConfirm({ kind: 'clear', ids: [current.id], name: nameOf(current) })}
            onDelete={() => setConfirm({ kind: 'delete', ids: [current.id], name: nameOf(current) })}
            isMobile={isMobile}
            hasBots={bots.length > 0}
            quickReplies={quickReplies}
            onSent={(m) => setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]))}
            onUpdate={updateConversation}
          />
        )}
      </section>

      {/* ------------------------------------------------ contacto */}
      {panelVisible ? (
        <ContactPanel
          conversation={current}
          notes={notes}
          users={users}
          hasBots={bots.length > 0}
          mobile={isMobile}
          onClose={() => (isMobile ? setPanelMobile(false) : setShowPanel(false))}
          onClear={() => setConfirm({ kind: 'clear', ids: [current.id], name: nameOf(current) })}
          onDelete={() => setConfirm({ kind: 'delete', ids: [current.id], name: nameOf(current) })}
          onUpdate={updateConversation}
          onToggleBot={toggleBot}
          onContactUpdate={(contact) => setCurrent((c) => ({ ...c, contact: { ...c.contact, ...contact } }))}
          onNoteAdded={(note) => setNotes((n) => [note, ...n])}
        />
      ) : null}

      {confirm ? (
        <Confirm
          title={confirm.kind === 'clear' ? '¿Vaciar este chat?' : confirm.ids.length > 1 ? `¿Eliminar ${confirm.ids.length} chats?` : `¿Eliminar el chat con ${confirm.name}?`}
          confirmLabel={confirm.kind === 'clear' ? 'Vaciar chat' : confirm.ids.length > 1 ? `Eliminar ${confirm.ids.length} chats` : 'Eliminar chat'}
          danger
          busy={busy}
          onConfirm={runConfirm}
          onClose={() => setConfirm(null)}
        >
          {confirm.kind === 'clear' ? (
            <>Se borran todos los mensajes y archivos de esta conversación. Se conservan el contacto, las etiquetas, las notas internas y la asignación. Los mensajes <strong>no se borran del WhatsApp del cliente</strong>.</>
          ) : (
            <>Se eliminan la conversación, sus mensajes, archivos y notas internas del CRM. El contacto se conserva; si vuelve a escribir, se abrirá un chat nuevo. Esto no afecta al WhatsApp del cliente ni al historial en Meta.</>
          )}
        </Confirm>
      ) : null}
    </div>
  );
}

/* ========================================================================== */
function ConversationRow({ conversation: c, active, selectMode, selected, canWrite, onClick, onLongPress, onClear, onDelete, onSelect }) {
  const name = c.contact?.name || fmtPhone(c.contact?.waId) || 'Sin nombre';
  const pressTimer = useRef(null);
  const pressed = useRef(false);

  // Mantener pulsado (como en WhatsApp) entra en modo selección.
  const startPress = () => {
    pressed.current = false;
    clearTimeout(pressTimer.current);
    pressTimer.current = setTimeout(() => { pressed.current = true; onLongPress?.(); }, 500);
  };
  const endPress = () => clearTimeout(pressTimer.current);
  const handleClick = () => { if (pressed.current) { pressed.current = false; return; } onClick(); };

  return (
    <div
      className={`conv ${active ? 'active' : ''} ${selected ? 'selected' : ''} ${selectMode ? 'selecting' : ''}`}
      onClick={handleClick}
      onTouchStart={startPress}
      onTouchEnd={endPress}
      onTouchMove={endPress}
      onContextMenu={(e) => { if (canWrite) { e.preventDefault(); onLongPress?.(); } }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onClick()}
    >
      {selectMode ? (
        <span className={`select-dot ${selected ? 'on' : ''}`} aria-hidden="true">{selected ? <I.check /> : null}</span>
      ) : (
        <Avatar name={c.contact?.name || c.contact?.waId} />
      )}
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="row between">
          <span className={`name truncate ${c.unreadCount > 0 ? 'unread' : ''}`}>{name}</span>
          <span className={`time ${c.unreadCount > 0 ? 'unread' : ''}`}>{fmtTime(c.lastMessageAt)}</span>
        </div>
        <div className="row between" style={{ gap: 6 }}>
          <div className="preview truncate">{c.lastMessagePreview || '—'}</div>
          {c.unreadCount > 0 ? <span className="badge solid">{c.unreadCount}</span> : null}
        </div>
        <div className="meta">
          <ChannelTag bot={c.bot} integration={c.integration} />
          {c.status !== 'open' ? <span className={`badge ${c.status === 'pending' ? 'warn' : ''}`}>{CONV_STATUS[c.status]}</span> : null}
          {c.assignedUser ? <span className="badge">{c.assignedUser.name.split(' ')[0]}</span> : null}
          {c.botActive ? <span className="badge accent" title={c.bot ? `${c.bot.name} responde en este chat` : 'bot activo'}>{c.botActive && c.bot ? 'bot activo' : 'bot'}</span> : c.botPausedUntil ? <span className="badge warn">bot en pausa</span> : null}
        </div>
      </div>
      {canWrite && !selectMode ? (
        <span className="row-menu">
          <Menu
            trigger={<button type="button" className="btn ghost icon sm" aria-label="Opciones del chat"><I.more /></button>}
            items={[
              { label: 'Abrir chat', icon: <I.inbox />, onClick: onClick },
              { label: 'Seleccionar', icon: <I.checkSquare />, onClick: onSelect },
              { divider: true },
              { label: 'Vaciar chat', icon: <I.broom />, onClick: onClear },
              { label: 'Eliminar chat', icon: <I.trash />, onClick: onDelete, danger: true },
            ]}
          />
        </span>
      ) : null}
    </div>
  );
}

/* ========================================================================== */
function Thread({ conversation: c, messages, onBack, onTogglePanel, onToggleBot, onClear, onDelete, hasBots, quickReplies, onSent, onUpdate, isMobile }) {
  const { user } = useAuth();
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const scrollRef = useRef(null);
  const fileRef = useRef(null);
  const textRef = useRef(null);
  const canWrite = hasRole(user, 'agent');
  const windowOpen = c.withinServiceWindow;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, c.id]);

  const grouped = useMemo(() => {
    const out = [];
    let lastDay = null;
    for (const m of messages) {
      const day = dayKey(m.createdAt);
      if (day !== lastDay) { out.push({ sep: day, key: `sep-${day}` }); lastDay = day; }
      out.push({ message: m, key: m.id });
    }
    return out;
  }, [messages]);

  const pickerMatches = useMemo(() => {
    if (!draft.startsWith('/')) return [];
    const term = draft.slice(1).toLowerCase();
    return quickReplies.filter((q) => q.shortcut.startsWith(term) || q.title.toLowerCase().includes(term)).slice(0, 8);
  }, [draft, quickReplies]);

  useEffect(() => { setPickerOpen(pickerMatches.length > 0); }, [pickerMatches]);

  async function sendText() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const m = await post(`/api/conversations/${c.id}/messages`, { type: 'text', text });
      onSent(m);
      setDraft('');
      if (c.botActive) onUpdate({}).catch(() => {});
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      setSending(false);
      textRef.current?.focus();
    }
  }

  async function sendTemplate({ name, language, components }) {
    try {
      const m = await post(`/api/conversations/${c.id}/messages`, { type: 'template', template: { name, language, components } });
      onSent(m);
      toast('Plantilla en cola de envío');
    } catch (err) {
      toast(err.message, { error: true });
      throw err;
    }
  }

  async function sendFile(file) {
    if (!file) return;
    setSending(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const m = await api(`/api/conversations/${c.id}/media`, { method: 'POST', body: form, raw: true });
      onSent(m);
      toast('Archivo en cola de envío');
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      setSending(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function onKey(e) {
    if (e.key === 'Enter' && !e.shiftKey && !pickerOpen) { e.preventDefault(); sendText(); }
    if (e.key === 'Escape') setPickerOpen(false);
    if (pickerOpen && e.key === 'Enter') { e.preventDefault(); applyQuick(pickerMatches[0]); }
  }
  function applyQuick(q) {
    if (!q) return;
    setDraft(q.body.replace(/\{\{\s*contact\.name\s*\}\}/g, c.contact?.name ?? ''));
    setPickerOpen(false);
    textRef.current?.focus();
  }

  const title = c.contact?.name || fmtPhone(c.contact?.waId);

  return (
    <>
      <div className="thread-head">
        <div className="row thread-title" style={{ minWidth: 0 }} onClick={onTogglePanel} role="button" tabIndex={0} title="Ver info del contacto">
          <button className="btn ghost icon" onClick={(e) => { e.stopPropagation(); onBack(); }} aria-label="Volver" style={{ display: 'inline-flex' }}><I.back /></button>
          <Avatar name={c.contact?.name || c.contact?.waId} />
          <div style={{ minWidth: 0 }}>
            <div className="truncate" style={{ fontWeight: 600 }}>{title}</div>
            <div className="tiny faint row" style={{ gap: 6, flexWrap: 'nowrap' }}>
              <ChannelTag bot={c.bot} integration={c.integration} />
              <span className="truncate">
                {isMobile ? (c.botActive ? 'bot activo' : c.botPausedUntil ? 'bot en pausa' : CONV_STATUS[c.status]) : `${fmtPhone(c.contact?.waId)} · ${CONV_STATUS[c.status]} · ${c.pipelineStage}`}
                {isMobile ? ' · toca para ver info' : ''}
              </span>
            </div>
          </div>
        </div>
        <div className="row" style={{ flex: 'none' }}>
          <span className="desktop-only row">
            {!canWrite ? (c.botActive ? <Badge tone="accent">bot activo</Badge> : c.botPausedUntil ? <Badge tone="warn">bot en pausa</Badge> : null) : null}
            {canWrite ? (
              <Button size="sm" onClick={onToggleBot} title={hasBots ? '' : 'No hay chatbots conectados por el Bot Gateway'}>
                {c.botActive ? <><I.pause /> Pausar bot</> : <><I.play /> Reactivar bot</>}
              </Button>
            ) : null}
            {canWrite && c.status !== 'closed' ? <Button size="sm" onClick={() => onUpdate({ status: 'closed' })}>Cerrar</Button> : null}
            {c.status === 'closed' && canWrite ? <Button size="sm" onClick={() => onUpdate({ status: 'open' })}>Reabrir</Button> : null}
            <Button size="sm" variant="ghost" className="icon" onClick={onTogglePanel} aria-label="Panel de contacto" title="Info del contacto"><I.user /></Button>
          </span>
          <Menu
            trigger={<Button variant="ghost" className="icon" aria-label="Más opciones"><I.more /></Button>}
            items={[
              { label: 'Info del contacto', icon: <I.info />, onClick: onTogglePanel },
              canWrite ? { label: c.botActive ? 'Pausar bot' : 'Reactivar bot', icon: c.botActive ? <I.pause /> : <I.play />, onClick: onToggleBot } : null,
              canWrite ? { label: c.status === 'closed' ? 'Reabrir conversación' : 'Cerrar conversación', icon: <I.archive />, onClick: () => onUpdate({ status: c.status === 'closed' ? 'open' : 'closed' }) } : null,
              canWrite ? { divider: true } : null,
              canWrite ? { label: 'Vaciar chat', icon: <I.broom />, onClick: onClear } : null,
              canWrite ? { label: 'Eliminar chat', icon: <I.trash />, onClick: onDelete, danger: true } : null,
            ]}
          />
        </div>
      </div>

      {c.integration === null || c.integration?.active === false ? (
        <div className="notice" style={{ background: 'var(--crit-soft)', color: 'var(--crit)' }}>
          <span>{c.integration === null ? 'Este chat no tiene número de WhatsApp asignado: lo abrió un chatbot antes de que el CRM supiera por qué número salía, o el número se eliminó. Se conserva el historial, pero no se puede responder. Un administrador puede asignarlo en Números de WhatsApp → "Asignar chats sin número".' : `El número ${c.integration.displayPhoneNumber} está desactivado: actívalo en Números de WhatsApp para responder.`}</span>
        </div>
      ) : null}

      {!windowOpen ? (
        <div className="notice">
          <span>La ventana de 24 h está cerrada. Solo puedes enviar una plantilla aprobada hasta que el cliente vuelva a escribir.</span>
          {canWrite ? <Button size="sm" onClick={() => setShowTemplates(true)}><I.template /> Enviar plantilla</Button> : null}
        </div>
      ) : null}

      {!hasBots && c.botActive ? (
        <div className="notice" style={{ background: 'var(--info-soft)', color: 'var(--info)' }}>
          <span>No hay chatbots conectados por el Bot Gateway. Si este número responde con la IA de Meta desde la app, el CRM no puede pausarla: solo muestra sus mensajes.</span>
        </div>
      ) : null}

      <div className="messages" ref={scrollRef}>
        {grouped.map((g) => (g.sep ? <div key={g.key} className="day-sep">{g.sep}</div> : <MessageBubble key={g.key} message={g.message} />))}
        {messages.length === 0 ? <Empty title="Sin mensajes todavía" /> : null}
      </div>

      {canWrite ? (
        <div className="composer">
          <div className="bar" style={{ position: 'relative' }}>
            {pickerOpen ? (
              <div className="picker">
                {pickerMatches.map((q, i) => (
                  <button key={q.id} className={i === 0 ? 'active' : ''} onClick={() => applyQuick(q)}>
                    <span className="sc">/{q.shortcut}</span> · {q.title}
                    <div className="small muted truncate">{q.body}</div>
                  </button>
                ))}
              </div>
            ) : null}
            <div className="tools">
              <input ref={fileRef} type="file" hidden onChange={(e) => sendFile(e.target.files?.[0])} accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx" />
              <Button variant="ghost" size="icon" className="icon" onClick={() => fileRef.current?.click()} disabled={!windowOpen || sending} title="Adjuntar archivo"><I.clip /></Button>
              <Button variant="ghost" className="icon" onClick={() => setShowTemplates(true)} title="Enviar plantilla"><I.template /></Button>
              <Button variant="ghost" className="icon" onClick={() => setDraft('/')} title="Respuestas rápidas (escribe /)"><I.bolt /></Button>
            </div>
            <textarea
              id="composer"
              ref={textRef}
              className="textarea"
              rows={1}
              placeholder={windowOpen ? 'Escribe un mensaje… ( / para respuestas rápidas )' : 'Ventana cerrada: usa una plantilla'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKey}
              disabled={!windowOpen || sending}
            />
            <Button id="send-btn" variant="primary" onClick={sendText} disabled={!windowOpen || !draft.trim()} loading={sending}><I.send /><span className="send-label"> Enviar</span></Button>
          </div>
        </div>
      ) : null}

      {showTemplates ? <TemplatePicker onClose={() => setShowTemplates(false)} onSend={sendTemplate} contact={c.contact} /> : null}
    </>
  );
}

/* ========================================================================== */
function ContactPanel({ conversation: c, notes, users, hasBots, mobile = false, onClose, onClear, onDelete, onUpdate, onToggleBot, onContactUpdate, onNoteAdded }) {
  const { user } = useAuth();
  const toast = useToast();
  const canWrite = hasRole(user, 'agent');
  const [name, setName] = useState(c.contact?.name ?? '');
  const [tag, setTag] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { setName(c.contact?.name ?? ''); }, [c.contact?.id, c.contact?.name]);

  async function saveName() {
    if (name === (c.contact?.name ?? '')) return;
    try {
      const updated = await patch(`/api/contacts/${c.contact.id}`, { name: name.trim() });
      onContactUpdate(updated);
      toast('Nombre guardado');
    } catch (err) { toast(err.message, { error: true }); }
  }
  async function addTag() {
    const t = tag.trim().toLowerCase();
    if (!t) return;
    const tags = Array.from(new Set([...(c.contact.tags ?? []), t]));
    const updated = await patch(`/api/contacts/${c.contact.id}`, { tags });
    onContactUpdate(updated);
    setTag('');
  }
  async function removeTag(t) {
    const tags = (c.contact.tags ?? []).filter((x) => x !== t);
    const updated = await patch(`/api/contacts/${c.contact.id}`, { tags });
    onContactUpdate(updated);
  }
  async function addNote() {
    if (!note.trim()) return;
    setBusy(true);
    try {
      const created = await post(`/api/conversations/${c.id}/notes`, { body: note.trim() });
      onNoteAdded(created);
      setNote('');
    } catch (err) { toast(err.message, { error: true }); } finally { setBusy(false); }
  }

  return (
    <aside className="pane contact-panel">
      {mobile ? (
        <div className="pane-head">
          <div className="row">
            <button className="btn ghost icon" onClick={onClose} aria-label="Volver al chat"><I.back /></button>
            <h2>Info del contacto</h2>
          </div>
        </div>
      ) : null}
      <div className="pane-scroll">
        <div className="section" style={{ alignItems: 'center', textAlign: 'center' }}>
          <Avatar name={c.contact?.name || c.contact?.waId} size="lg" />
          {canWrite ? (
            <input className="input" style={{ textAlign: 'center', fontWeight: 600 }} value={name} placeholder="Nombre del contacto" onChange={(e) => setName(e.target.value)} onBlur={saveName} onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} />
          ) : (
            <strong>{c.contact?.name || 'Sin nombre'}</strong>
          )}
          <a className="mono small" href={`https://wa.me/${c.contact?.waId}`} target="_blank" rel="noreferrer">{fmtPhone(c.contact?.waId)}</a>
          {!mobile ? <button className="btn ghost sm" onClick={onClose}>Ocultar panel</button> : null}
        </div>

        <div className="section">
          <h4>Etiquetas</h4>
          <div className="chips">
            {(c.contact?.tags ?? []).map((t) => (
              <span key={t} className="tag">{t}{canWrite ? <button onClick={() => removeTag(t)} aria-label={`Quitar ${t}`}>×</button> : null}</span>
            ))}
            {(c.contact?.tags ?? []).length === 0 ? <span className="small faint">Sin etiquetas</span> : null}
          </div>
          {canWrite ? (
            <div className="row">
              <input className="input" placeholder="Nueva etiqueta" value={tag} onChange={(e) => setTag(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addTag()} />
              <Button size="sm" onClick={addTag}><I.plus /></Button>
            </div>
          ) : null}
        </div>

        <div className="section">
          <h4>Conversación</h4>
          <label className="field"><span className="label">Estado</span>
            <select className="select" value={c.status} disabled={!canWrite} onChange={(e) => onUpdate({ status: e.target.value })}>
              {Object.entries(CONV_STATUS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="field"><span className="label">Etapa del embudo</span>
            <select className="select" value={c.pipelineStage} disabled={!canWrite} onChange={(e) => onUpdate({ pipelineStage: e.target.value })}>
              {Array.from(new Set([...STAGES, c.pipelineStage])).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          {users.length ? (
            <label className="field"><span className="label">Asignada a</span>
              <select className="select" value={c.assignedUser?.id ?? ''} onChange={(e) => onUpdate({ assignedUserId: e.target.value || null })}>
                <option value="">Sin asignar</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </label>
          ) : null}
          <div className="row between">
            <span className="small">Bot activo</span>
            <Switch on={c.botActive} onChange={onToggleBot} disabled={!canWrite} />
          </div>
          {!hasBots ? <p className="tiny faint">Solo aplica a chatbots conectados por el Bot Gateway.</p> : null}
          {c.botPausedUntil && !c.botActive ? <p className="tiny faint">Se reactiva solo el {fmtDateTime(c.botPausedUntil)}.</p> : null}
        </div>

        <div className="section">
          <h4>Atendido por</h4>
          <ChannelTag bot={c.bot} integration={c.integration} />
          {c.integration ? (
            <p className="tiny faint" style={{ margin: '6px 0 0' }}>
              {c.bot ? `Chatbot ${c.bot.name} · ` : 'Sin chatbot por Bot Gateway · '}número <span className="mono">{c.integration.displayPhoneNumber}</span>{c.integration.verifiedName ? ` (${c.integration.verifiedName})` : ''}
            </p>
          ) : (
            <p className="tiny faint" style={{ margin: '6px 0 0' }}>Sin número asignado: no se puede responder desde el CRM.</p>
          )}
        </div>

        <div className="section">
          <h4>Ventana de 24 h</h4>
          {c.withinServiceWindow ? (
            <p className="small"><Badge tone="ok">abierta</Badge> hasta {fmtDateTime(c.windowExpiresAt)}</p>
          ) : (
            <p className="small"><Badge tone="warn">cerrada</Badge> último mensaje del cliente: {fmtDateTime(c.lastInboundAt)}</p>
          )}
        </div>

        <div className="section">
          <h4>Notas internas</h4>
          {canWrite ? (
            <div className="col">
              <textarea className="textarea" style={{ minHeight: 60 }} placeholder="Solo las ve tu equipo" value={note} onChange={(e) => setNote(e.target.value)} />
              <Button size="sm" onClick={addNote} loading={busy} disabled={!note.trim()}>Guardar nota</Button>
            </div>
          ) : null}
          {notes.map((n) => (
            <div key={n.id} className="note">
              {n.body}
              <div className="by">{n.user?.name} · {fmtDateTime(n.createdAt)}</div>
            </div>
          ))}
          {notes.length === 0 ? <span className="small faint">Sin notas</span> : null}
        </div>

        {canWrite ? (
          <div className="section">
            <button type="button" className="panel-action" onClick={onClear}><I.broom /> Vaciar chat</button>
            <button type="button" className="panel-action danger" onClick={onDelete}><I.trash /> Eliminar chat</button>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
