import { getContext, extension_settings } from '../../../extensions.js';
import { user_avatar } from '../../../../script.js';
import { zipSync, strToU8 } from './fflate.js';

const MAX_BYTES = 256 * 1024 * 1024;
const EXPORT_LABEL = '실리북스로 내보내기';
let exporting = false;
const setExportLabel = (button, text) => { button.querySelector('.sb-book-export-label').textContent = text; };
const assetKey = value => String(value || '').trim().replace(/\\_/g, '_').normalize('NFC').toLowerCase();
const withoutExtension = value => value.replace(/\.[^./]+$/, '');

async function buildAssetIndex(context) {
    const settings = extension_settings?.['character-assets']?.characterAssets || {};
    const character = context.characters?.[context.characterId];
    const group = context.groups?.find(group => String(group.id) === String(context.groupId));
    const members = context.groupId ? (group?.members || []) : [character?.avatar];
    const names = members.filter(Boolean).map(avatar => withoutExtension(avatar));
    if (user_avatar && user_avatar !== 'img/user-default.png') names.push('_persona_' + withoutExtension(user_avatar));
    const index = new Map();
    for (const name of [...new Set(names)]) {
        const options = settings[name] || {};
        const base = options.linkedCharacter || name;
        const effective = options.activeAssetPreset ? `${base}/${options.activeAssetPreset}` : base;
        const response = await fetch(`/api/sprites/get?name=${encodeURIComponent(effective)}`, { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`에셋 폴더 목록을 읽지 못했습니다: ${effective} (HTTP ${response.status})`);
        const assets = await response.json();
        if (!Array.isArray(assets)) throw new Error(`에셋 목록 형식이 잘못되었습니다: ${effective}`);
        for (const asset of assets) {
            if (typeof asset.path !== 'string') continue;
            const encoded = asset.path.split('?')[0].split('/').pop();
            let filename = encoded;
            try { filename = decodeURIComponent(encoded); } catch { filename = encoded; }
            for (const alias of [filename, withoutExtension(filename), asset.label]) {
                const key = assetKey(alias);
                if (key && !index.has(key)) index.set(key, asset.path);
            }
        }
    }
    return index;
}

function imageExtension(bytes, mime) {
    if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return 'png';
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
    const header = new TextDecoder().decode(bytes.subarray(0, 16));
    if (header.startsWith('GIF8')) return 'gif';
    if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'webp';
    if (header.startsWith('BM')) return 'bmp';
    if (header.slice(4, 8) === 'ftyp' && /avif|avis/.test(header)) return 'avif';
    if (mime === 'image/avif') return 'avif';
    throw new Error('지원하는 이미지 파일이 아닙니다');
}
function stableId(text) {
    return [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35].map(seed => {
        let hash = seed;
        for (const character of text) hash = Math.imul(hash ^ character.codePointAt(0), 0x01000193) >>> 0;
        return hash.toString(16).padStart(8, '0');
    }).join('');
}
export function ensureBookExportButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('sb-book-export')) return;
    const button = document.createElement('div');
    button.id = 'sb-book-export';
    button.className = 'list-group-item flex-container flexGap5 interactable';
    button.setAttribute('role', 'button');
    button.tabIndex = 0;
    const icon = document.createElement('div');
    icon.className = 'fa-solid fa-book-open-reader extensionsMenuExtensionButton';
    const label = document.createElement('span');
    label.className = 'sb-book-export-label';
    label.textContent = EXPORT_LABEL;
    button.append(icon, label);
    button.onclick = () => void exportBook(button);
    button.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); button.click(); } };
    menu.append(button);
}

async function exportBook(button) {
    if (exporting) return;
    exporting = true;
    button.setAttribute('aria-disabled', 'true');
    try {
        const context = getContext();
        if (!context.chat?.length) throw new Error('먼저 내보낼 채팅방을 열어 주세요.');
        if (context.streamingProcessor && !context.streamingProcessor.isFinished) throw new Error('답변 생성이 끝난 뒤 내보내 주세요.');
        const messages = structuredClone(context.chat);
        const character = context.characters?.[context.characterId];
        const identity = JSON.stringify([context.groupId || character?.avatar || context.name2, context.chatId || context.getCurrentChatId()]);
        const id = stableId(identity);
        const manifest = { format: 'sillybooks-book', version: 1, id, title: String(context.chatId || '채팅'), character: String(context.name2 || '캐릭터'), chat: 'chat.jsonl', assets: {}, missingAssets: [] };
        const sources = new Set();
        function collect(value) {
            if (typeof value === 'string') {
                for (const match of value.matchAll(/((?:src\s*=\s*["']|!\[[^\]]*\]\())([^"')]+)(["']|\))/gi)) sources.add(match[2].trim());
                for (const match of value.matchAll(/\{\{\s*img::\s*([^{}]+?)\s*\}\}/gi)) sources.add(match[1].trim().replace(/\\_/g, '_'));
                for (const match of value.matchAll(/<img\b[^>]*\bsrc\s*=\s*([^\s"'=<>`]+)[^>]*>/gi)) sources.add(match[1]);
            } else if (Array.isArray(value)) value.forEach(collect);
            else if (value && typeof value === 'object') {
                for (const [key, item] of Object.entries(value)) {
                    if (['image', 'image_url', 'force_avatar'].includes(key) && typeof item === 'string') sources.add(item);
                    if (key === 'image_swipes' && Array.isArray(item)) item.filter(url => typeof url === 'string').forEach(url => sources.add(url));
                    if (key === 'media' && Array.isArray(item)) item.forEach(media => { if (media?.url && (!media.type || media.type === 'image')) sources.add(media.url); });
                    if (key === 'files' && Array.isArray(item)) item.forEach(file => { if (file?.url && /\.(png|jpe?g|gif|webp|avif|bmp)(?:[?#].*)?$/i.test(file.name || file.url)) sources.add(file.url); });
                    collect(item);
                }
            }
        }
        collect(messages);
        const hasNamedAssets = [...sources].some(source => !/^(?:[a-z]+:|\/)/i.test(source) && !source.includes('/'));
        const assetIndex = hasNamedAssets ? await buildAssetIndex(context) : new Map();
        if (character?.avatar) { manifest.characterAvatar = `/characters/${encodeURIComponent(character.avatar)}`; sources.add(manifest.characterAvatar); }
        if (user_avatar) { manifest.personaAvatar = user_avatar === 'img/user-default.png' ? '/img/user-default.png' : `/User%20Avatars/${encodeURIComponent(user_avatar)}`; sources.add(manifest.personaAvatar); }
        const header = { user_name: context.name1, character_name: context.name2, chat_metadata: { silly_books_export: true } };
        const files = { 'chat.jsonl': strToU8([header, ...messages].map(value => JSON.stringify(value)).join('\n')) };
        let size = files['chat.jsonl'].byteLength;
        if (size > MAX_BYTES) throw new Error('채팅의 용량이 매우 큽니다. 256MB 이하만 지원됩니다.');
        let cursor = 0;
        const failures = [];
        const bundledUrls = new Map();
        for (const source of sources) {
            setExportLabel(button, `이미지 모으는 중 ${++cursor}/${sources.size}`);
            if (/^data:image\//i.test(source)) continue;
            try {
                const named = !/^(?:[a-z]+:|\/)/i.test(source) && !source.includes('/');
                const resolved = named ? (assetIndex.get(assetKey(source)) || assetIndex.get(withoutExtension(assetKey(source)))) : source;
                if (!resolved) throw new Error('현재 캐릭터·연결 캐릭터·프리셋·페르소나 에셋에서 찾지 못했어요');
                const url = new URL(resolved.replace(/&amp;/g, '&'), location.href);
                if (!['https:', 'http:'].includes(url.protocol)) throw new Error('unsupported source');
                if (bundledUrls.has(url.href)) { manifest.assets[source] = bundledUrls.get(url.href); continue; }
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 15000);
                let response;
                let bytes;
                try {
                    response = await fetch(url, { credentials: url.origin === location.origin ? 'same-origin' : 'omit', signal: controller.signal });
                    if (!response.ok) throw new Error(`이미지 읽기 실패 (HTTP ${response.status})`);
                    if (Number(response.headers.get('content-length')) > MAX_BYTES - size) throw new Error('asset too large');
                    bytes = new Uint8Array(await response.arrayBuffer());
                } finally { clearTimeout(timer); }
                const mime = response.headers.get('content-type')?.split(';')[0];
                const ext = imageExtension(bytes, mime);
                if (size + bytes.byteLength > MAX_BYTES) throw new Error('asset too large');
                size += bytes.byteLength;
                const path = `assets/${cursor}.${ext}`;
                files[path] = bytes;
                manifest.assets[source] = path;
                bundledUrls.set(url.href, path);
            } catch (error) {
                failures.push(`${source}: ${error.message || '읽기 실패'}`);
                manifest.missingAssets.push(source);
            }
        }
        if (failures.length) console.warn('[실리북스] 찾을 수 없는 이미지를 빼고 내보냈습니다.', failures);
        files['manifest.json'] = strToU8(JSON.stringify(manifest));
        const archive = zipSync(files, { level: 0 });
        if (archive.byteLength > MAX_BYTES) throw new Error('책이 256MB를 넘습니다. 이미지 수를 줄여 주세요.');
        const url = URL.createObjectURL(new Blob([archive], { type: 'application/zip' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `${manifest.title.replace(/[<>:"/\\|?*]/g, '_')}.sillybooks.zip`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        globalThis.toastr?.success(failures.length ? '찾을 수 없는 이미지를 제외한 채팅 내용을 실리북스로 내보냈습니다.' : `채팅과 이미지 ${Object.keys(manifest.assets).length}개를 담아 실리북스로 내보냈습니다.`);
    } catch (error) { globalThis.toastr?.error(error.message || '책을 내보내지 못했습니다.'); }
    finally { exporting = false; button.removeAttribute('aria-disabled'); setExportLabel(button, EXPORT_LABEL); }
}
