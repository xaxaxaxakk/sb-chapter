import { ensureBookExportButton } from './book-export.js';
import { eventSource, event_types } from '../../../../script.js';
import { getContext } from '../../../extensions.js';

const CHAPTER_FIELD = 'silly_books_chapter';
const BUTTON_CLASS = 'sb-chapter-toggle';
const savingMessages = new Set();
let injectFrame = 0;

function hasChapterMarker(message) {
    if (message?.extra?.[CHAPTER_FIELD] === true) return true;
    return Array.isArray(message?.swipe_info) && message.swipe_info.some((swipe) => swipe?.extra?.[CHAPTER_FIELD] === true);
}

function isChapterMessage(messageId) {
    return hasChapterMarker(getContext()?.chat?.[messageId]);
}

function setChapterMarker(message, active) {
    if (!message.extra || typeof message.extra !== 'object') message.extra = {};
    if (active) message.extra[CHAPTER_FIELD] = true;
    else delete message.extra[CHAPTER_FIELD];

    if (!Array.isArray(message.swipe_info)) return;
    message.swipe_info.forEach((swipe) => {
        if (!swipe || typeof swipe !== 'object') return;
        if (!swipe.extra || typeof swipe.extra !== 'object') swipe.extra = {};
        if (active) swipe.extra[CHAPTER_FIELD] = true;
        else delete swipe.extra[CHAPTER_FIELD];
    });
}

function updateButton(button, active) {
    const label = active ? '챕터 시작 해제' : '챕터 시작으로 등록';

    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(active));
    button.dataset.chapterActive = String(active);
    button.style.color = active ? 'var(--fullred, #d43c3c)' : '';
    button.style.opacity = active ? '1' : '';
}

async function writeChapterMarker(messageId, active, onRollback) {
    if (savingMessages.has(messageId)) return false;

    const context = getContext();
    const message = context?.chat?.[messageId];
    if (!message) return false;

    savingMessages.add(messageId);
    const wasActive = hasChapterMarker(message);

    try {
        setChapterMarker(message, active);
        await context.saveChat();
        globalThis.toastr?.success(active ? '챕터 시작점으로 등록 완료' : '챕터 지정 해제');
        return true;
    } catch (error) {
        setChapterMarker(message, wasActive);
        onRollback?.(wasActive);
        globalThis.toastr?.error('챕터 정보를 저장하지 못했습니다.');
        console.error('챕터 정보 저장 실패.', error);
        return false;
    } finally {
        savingMessages.delete(messageId);
        queueInject();
    }
}

async function toggleChapter(messageId, button) {
    const message = getContext()?.chat?.[messageId];
    if (!message) return;
    const next = !hasChapterMarker(message);
    updateButton(button, next);
    await writeChapterMarker(messageId, next, (restored) => updateButton(button, restored));
}

function addButton(messageElement) {
    if (!(messageElement instanceof HTMLElement)) return;
    const messageId = Number(messageElement.getAttribute('mesid'));
    if (!Number.isInteger(messageId) || !getContext()?.chat?.[messageId]) return;

    const actions = messageElement.querySelector('.extraMesButtons');
    if (!actions) return;

    let button = actions.querySelector(`.${BUTTON_CLASS}`);
    if (!button) {
        button = document.createElement('div');
        button.className = `mes_button ${BUTTON_CLASS} interactable fa-solid fa-book-bookmark`;
        button.setAttribute('role', 'button');
        button.setAttribute('tabindex', '0');
        button.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const currentId = Number(messageElement.getAttribute('mesid'));
            if (Number.isInteger(currentId)) await toggleChapter(currentId, button);
        });
        button.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            button.click();
        });
        actions.append(button);
    }

    updateButton(button, isChapterMessage(messageId));
}

const WAND_BUTTON_ID = 'sb_chapter_wand_button';

function chapterMessages() {
    const chat = getContext()?.chat;
    if (!Array.isArray(chat)) return [];
    return chat.map((message, messageId) => ({ messageId, message })).filter((entry) => hasChapterMarker(entry.message));
}

function previewOf(message) {
    const text = String(message?.mes || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/[*_`~#>]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!text) return '(빈 메시지)';
    return text.length > 70 ? `${text.slice(0, 70)}…` : text;
}

function renderChapterList(list, closePopup) {
    list.innerHTML = '';
    const entries = chapterMessages();

    if (!entries.length) {
        const empty = document.createElement('p');
        empty.className = 'sb-chapter-empty';
        empty.textContent = '등록된 챕터가 없습니다. 메시지의 북마크 버튼으로 챕터 시작점을 지정하세요.';
        list.append(empty);
        return;
    }

    entries.forEach((entry, index) => {
        const row = document.createElement('div');
        row.className = 'sb-chapter-row';
        row.dataset.mesid = String(entry.messageId);

        const order = document.createElement('div');
        order.className = 'sb-chapter-order';
        order.textContent = String(index + 1);

        const body = document.createElement('div');
        body.className = 'sb-chapter-body';
        const meta = document.createElement('div');
        meta.className = 'sb-chapter-meta';
        meta.textContent = `메시지 ${entry.messageId} · ${entry.message?.name || '이름 없음'}`;
        const preview = document.createElement('div');
        preview.className = 'sb-chapter-preview';
        preview.textContent = previewOf(entry.message);
        body.append(meta, preview);

        const jump = document.createElement('div');
        jump.className = 'sb-chapter-action sb-chapter-jump interactable';
        jump.setAttribute('role', 'button');
        jump.setAttribute('tabindex', '0');
        jump.title = '이 메시지로 이동';
        jump.setAttribute('aria-label', `메시지 ${entry.messageId}로 이동`);
        jump.innerHTML = '<i class="fa-solid fa-location-arrow"></i>';
        jump.addEventListener('click', async () => {
            await closePopup();
            await getContext().executeSlashCommandsWithOptions(`/chat-jump ${entry.messageId}`);
        });

        const remove = document.createElement('div');
        remove.className = 'sb-chapter-action sb-chapter-remove interactable';
        remove.setAttribute('role', 'button');
        remove.setAttribute('tabindex', '0');
        remove.title = '챕터 지정 해제';
        remove.setAttribute('aria-label', `메시지 ${entry.messageId}의 챕터 지정 해제`);
        remove.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        remove.addEventListener('click', async () => {
            const saved = await writeChapterMarker(entry.messageId, false);
            if (saved) renderChapterList(list, closePopup);
        });

        [jump, remove].forEach((action) => action.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            action.click();
        }));

        row.append(order, body, jump, remove);
        list.append(row);
    });
}

async function openChapterManager() {
    const context = getContext();
    const { Popup, POPUP_TYPE } = context;
    if (!Popup || !POPUP_TYPE) {
        globalThis.toastr?.error('이 버전의 실리태번에서는 챕터 관리창을 열 수 없습니다.');
        return;
    }

    const content = document.createElement('div');
    content.className = 'sb-chapter-manager';
    const heading = document.createElement('h3');
    heading.textContent = '챕터 관리';
    const hint = document.createElement('p');
    hint.className = 'sb-chapter-hint';
    hint.textContent = '이 채팅에 등록된 챕터입니다. 화살표로 해당 메시지로 이동하고, X로 지정을 해제합니다.';
    const list = document.createElement('div');
    list.className = 'sb-chapter-list';
    content.append(heading, hint, list);

    const popup = new Popup(content, POPUP_TYPE.TEXT, '', { okButton: '닫기', wide: true, allowVerticalScrolling: true });
    renderChapterList(list, () => popup.completeCancelled());
    await popup.show();
}

function ensureWandButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById(WAND_BUTTON_ID)) return;

    const item = document.createElement('div');
    item.id = WAND_BUTTON_ID;
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.setAttribute('role', 'button');
    item.setAttribute('tabindex', '0');
    const icon = document.createElement('div');
    icon.className = 'fa-solid fa-bookmark extensionsMenuExtensionButton';
    const label = document.createElement('span');
    label.textContent = '챕터 관리';
    item.append(icon, label);
    item.addEventListener('click', openChapterManager);
    menu.append(item);
}

function injectButtons() {
    document.querySelectorAll('#chat .mes[mesid]').forEach(addButton);
}

function queueInject() {
    if (injectFrame) cancelAnimationFrame(injectFrame);
    injectFrame = requestAnimationFrame(() => {
        injectFrame = 0;
        ensureWandButton();
        ensureBookExportButton();
        injectButtons();
    });
}

function handleMessageSwiped(messageId) {
    const message = getContext()?.chat?.[Number(messageId)];
    if (hasChapterMarker(message)) setChapterMarker(message, true);
    queueInject();
}

function initialize() {
    const events = [
        event_types.CHAT_CHANGED,
        event_types.CHAT_LOADED,
        event_types.MORE_MESSAGES_LOADED,
        event_types.MESSAGE_UPDATED,
        event_types.USER_MESSAGE_RENDERED,
        event_types.CHARACTER_MESSAGE_RENDERED,
    ];
    events.filter(Boolean).forEach((eventName) => eventSource.on(eventName, queueInject));
    if (event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, handleMessageSwiped);

    const observer = new MutationObserver(queueInject);
    observer.observe(document.body, { childList: true, subtree: true });
    queueInject();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
