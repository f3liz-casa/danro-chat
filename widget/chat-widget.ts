import twemoji from "@twemoji/api";
import * as v from "valibot";

type WelcomeFrame = { type: "welcome"; visitorId: string; nickname: string | null; email: string | null; returning: boolean; hasHistory: boolean; emojis: Record<string, string> };

const EmailSchema = v.pipe(v.string(), v.trim(), v.email());
type MessageFrame = { type: "message"; from: "visitor" | "agent"; text: string; ts: number; senderName?: string };
type HistoryEndFrame = { type: "history_end" };
type NicknameUpdatedFrame = { type: "nickname_updated"; nickname: string | null; email: string | null };
type ErrorFrame = { type: "error"; reason: string };
type ServerFrame = WelcomeFrame | MessageFrame | HistoryEndFrame | NicknameUpdatedFrame | ErrorFrame;

const STORAGE_KEY_BASE = "danro-talk:visitorId";

type Locale = "ja" | "ko";

type Strings = {
  headerTitle: string;
  nicknameSuffix: string;
  entryTitle: string;
  entryQ: string;
  entryHelp: string;
  entryPlaceholder: string;
  entryEmailLabel: string;
  entryEmailPlaceholder: string;
  entryButton: string;
  inputPlaceholder: string;
  hintHtml: string;
  sendButton: string;
  introHtml: string;
  emailInvalid: string;
  statusLoadingHistory: string;
  statusHistoryEnd: string;
  statusDisconnected: string;
  statusError: (reason: string) => string;
  attrMissing: string;
  openLabel: string;
  minimizeLabel: string;
};

const STRINGS: Record<Locale, Strings> = {
  ja: {
    headerTitle: "相談",
    nicknameSuffix: "さん",
    entryTitle: "はじめまして",
    entryQ: "お呼びする名前を教えてください。",
    entryHelp: "ニックネームで結構です。",
    entryPlaceholder: "例: うた",
    entryEmailLabel: "お返事が来たらお知らせします（任意）",
    entryEmailPlaceholder: "you@example.com",
    entryButton: "はじめる",
    inputPlaceholder: "ご相談を、まとめて",
    hintHtml: `<kbd>⌘/Ctrl + Enter</kbd> で送信、<kbd>Enter</kbd> で改行`,
    sendButton: "送信",
    introHtml: `
      <b>ご相談の内容を、ひとまとめにして</b>送ってください。<br>
      ゆっくり読んで、しっかりお返事します。<br>
      （数時間〜1日ほどかかることがあります）
    `,
    emailInvalid: "正しいメールアドレスを入力してください。",
    statusLoadingHistory: "これまでのやりとりを読み込んでいます…",
    statusHistoryEnd: "ここまでの履歴です",
    statusDisconnected: "つながりが切れました",
    statusError: (reason) => `エラー: ${reason}`,
    attrMissing: "ws-url 属性が必要です",
    openLabel: "相談をひらく",
    minimizeLabel: "最小化",
  },
  ko: {
    headerTitle: "상담",
    nicknameSuffix: "님",
    entryTitle: "안녕하세요",
    entryQ: "어떻게 불러드리면 좋을까요?",
    entryHelp: "닉네임도 괜찮아요.",
    entryPlaceholder: "예: 라온",
    entryEmailLabel: "답장이 오면 알려드릴게요 (선택)",
    entryEmailPlaceholder: "you@example.com",
    entryButton: "시작하기",
    inputPlaceholder: "편안하게 말씀해 주세요",
    hintHtml: `<kbd>⌘/Ctrl + Enter</kbd>로 전송, <kbd>Enter</kbd>로 줄바꿈`,
    sendButton: "보내기",
    introHtml: `
      <b>상담 내용을 한 번에 정리해서</b> 보내 주세요.<br>
      담당자가 확인하는 대로, 천천히 잘 생각해서 답장 드릴게요.<br>
      (몇 시간에서 하루 정도 걸릴 수 있어요)
    `,
    emailInvalid: "올바른 이메일 주소를 입력해 주세요.",
    statusLoadingHistory: "이전 대화를 불러오고 있어요…",
    statusHistoryEnd: "여기까지가 이전 대화예요",
    statusDisconnected: "연결이 끊어졌어요",
    statusError: (reason) => `문제가 생겼어요: ${reason}`,
    attrMissing: "ws-url 속성이 필요해요",
    openLabel: "상담 열기",
    minimizeLabel: "최소화",
  },
};

function detectLocale(el: HTMLElement): Locale {
  const attr = el.getAttribute("lang")?.toLowerCase();
  if (attr?.startsWith("ko")) return "ko";
  if (attr?.startsWith("ja")) return "ja";
  const docLang = document.documentElement.lang?.toLowerCase();
  if (docLang?.startsWith("ko")) return "ko";
  if (docLang?.startsWith("ja")) return "ja";
  const navLang = navigator.language?.toLowerCase() ?? "";
  if (navLang.startsWith("ko")) return "ko";
  return "ja";
}

const css = `
  :host {
    --bg: #fbfaf7;
    --fg: #2b2a26;
    --muted: #8a8780;
    --accent: #7a9b76;
    --visitor: #e9efe6;
    --agent: #ffffff;
    --border: #e6e3dc;
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 2147483000;
    font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif;
    font-size: 13px;
    color: var(--fg);
  }
  .wrap { display: contents; }
  .launcher {
    width: 56px;
    height: 56px;
    border-radius: 28px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--accent);
    cursor: pointer;
    display: grid;
    place-items: center;
    box-shadow: 0 6px 20px rgba(0,0,0,0.12);
    padding: 0;
    transition: transform 0.15s ease;
  }
  .launcher:hover { transform: translateY(-1px); }
  .launcher svg { width: 26px; height: 26px; }
  .wrap.open .launcher { display: none; }
  .wrap:not(.open) .panel { display: none; }
  .panel:lang(ko) { word-break: keep-all; line-break: strict; }
  .panel {
    display: flex;
    flex-direction: column;
    width: 320px;
    height: 510px;
    max-height: calc(100dvh - 32px);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    box-shadow: 0 12px 32px rgba(0,0,0,0.14);
  }
  header {
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    color: var(--muted);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }
  header strong { color: var(--fg); font-weight: 500; }
  header .title { display: flex; gap: 8px; align-items: baseline; min-width: 0; flex: 1; }
  header .title .who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .min-btn {
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    padding: 4px;
    border-radius: 6px;
    display: grid;
    place-items: center;
    min-width: 0;
  }
  .min-btn:hover { background: rgba(0,0,0,0.05); color: var(--fg); }
  .min-btn svg { width: 16px; height: 16px; display: block; }
  .who { color: var(--accent); }
  .log {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .msg {
    max-width: 80%;
    padding: 7px 11px;
    border-radius: 12px;
    font-size: 14px;
    line-height: 1.5;
    word-wrap: break-word;
    white-space: pre-wrap;
  }
  .msg.visitor { align-self: flex-end; background: var(--visitor); }
  .msg.agent { align-self: flex-start; background: var(--agent); border: 1px solid var(--border); }
  .msg .who { display: block; font-size: 11px; color: var(--muted); margin-bottom: 2px; }
  .msg .time { display: block; font-size: 10px; color: var(--muted); text-align: right; margin-top: 3px; }
  .inline-emoji { height: 1.2em; width: auto; vertical-align: -0.2em; margin: 0 1px; }
  img.emoji { height: 1.2em; width: 1.2em; vertical-align: -0.2em; margin: 0 1px; }
  .status { font-size: 12px; color: var(--muted); align-self: center; padding: 4px 0; }
  .entry {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: stretch;
    padding: 24px 20px;
    gap: 10px;
  }
  .entry h2 {
    font-size: 16px;
    font-weight: 500;
    margin: 0;
    color: var(--fg);
  }
  .entry p {
    font-size: 13px;
    color: var(--muted);
    margin: 0;
    line-height: 1.5;
  }
  .entry .sub {
    margin-top: 8px;
    font-size: 12px;
  }
  .entry input {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 10px;
    font: inherit;
    font-size: 14px;
    background: white;
    outline: none;
  }
  .entry input:focus { border-color: var(--accent); }
  .entry button {
    border: none;
    background: var(--accent);
    color: white;
    border-radius: 8px;
    padding: 8px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    margin-top: 4px;
  }
  .entry button:disabled { opacity: 0.4; cursor: default; }
  .panel.entering .log, .panel.entering form { display: none; }
  .panel:not(.entering) .entry { display: none; }
  .intro {
    align-self: stretch;
    background: #fff8ec;
    border: 1px solid #ecdcb8;
    border-radius: 10px;
    padding: 10px 12px;
    font-size: 13px;
    line-height: 1.6;
    color: #5a4a2a;
  }
  .intro b { font-weight: 600; }
  form {
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    background: var(--bg);
  }
  .row { display: flex; gap: 6px; align-items: flex-end; }
  .grow-wrap {
    flex: 1;
    display: grid;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: white;
    padding: 6px 10px;
    max-height: 160px;
    overflow-y: auto;
  }
  .grow-wrap:focus-within { border-color: var(--accent); }
  .grow-wrap::after {
    content: attr(data-replicated-value) " ";
    white-space: pre-wrap;
    visibility: hidden;
    font: inherit;
    line-height: 1.5;
  }
  .grow-wrap > textarea {
    resize: none;
    overflow: hidden;
    border: none;
    outline: none;
    font: inherit;
    line-height: 1.5;
    background: transparent;
  }
  .grow-wrap > textarea, .grow-wrap::after {
    grid-area: 1 / 1 / 2 / 2;
  }
  form button {
    border: none;
    background: var(--accent);
    color: white;
    border-radius: 8px;
    padding: 6px 10px;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    align-self: stretch;
    min-width: 48px;
  }
  form button:disabled { opacity: 0.4; cursor: default; }
  .hint {
    font-size: 11px;
    color: var(--muted);
    text-align: right;
    padding: 0 4px;
  }
  kbd {
    font-family: inherit;
    font-size: 10px;
    background: #ececec;
    border-radius: 3px;
    padding: 1px 4px;
  }
`;

class DanroTalk extends HTMLElement {
  private ws: WebSocket | null = null;
  private emojis: Record<string, string> = {};
  private nickname: string | null = null;
  private locale: Locale = "ja";
  private strings: Strings = STRINGS.ja;
  private storageKey: string = STORAGE_KEY_BASE;
  private panel!: HTMLDivElement;
  private wrap!: HTMLDivElement;
  private launcher!: HTMLButtonElement;
  private minBtn!: HTMLButtonElement;
  private openStorageKey: string = `${STORAGE_KEY_BASE}:open`;
  private entryInput!: HTMLInputElement;
  private entryEmail!: HTMLInputElement;
  private entryButton!: HTMLButtonElement;
  private log!: HTMLDivElement;
  private input!: HTMLTextAreaElement;
  private inputWrap!: HTMLDivElement;
  private button!: HTMLButtonElement;
  private headerName!: HTMLElement;

  connectedCallback(): void {
    this.locale = detectLocale(this);
    this.strings = STRINGS[this.locale];
    const siteId = this.getAttribute("site-id");
    const target = this.getAttribute("target") ?? "zulip";
    this.storageKey = `${STORAGE_KEY_BASE}:${siteId ?? target}`;
    this.openStorageKey = `${this.storageKey}:open`;
    const explicitUrl = this.getAttribute("ws-url");
    let url: string;
    if (explicitUrl) {
      url = explicitUrl;
    } else {
      const meta = new URL(import.meta.url);
      if (meta.protocol === "https:" || meta.protocol === "http:") {
        url = meta.origin.replace(/^https/, "wss").replace(/^http$/, "ws");
      } else {
        url = "wss://danro-api.atfedi.de";
      }
    }
    this.render();
    this.connect(url);
  }

  disconnectedCallback(): void {
    this.ws?.close();
  }

  private render(): void {
    const root = this.attachShadow({ mode: "open" });
    const s = this.strings;
    root.innerHTML = `
      <style>${css}</style>
      <div class="wrap" id="wrap-root">
      <button class="launcher" id="launcher" type="button" aria-label="${s.openLabel}" title="${s.openLabel}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 12a8 8 0 0 1-11.6 7.2L4 20l1-4.4A8 8 0 1 1 21 12z"/>
        </svg>
      </button>
      <div class="panel" id="panel" lang="${this.locale}">
        <header>
          <span class="title"><strong>${s.headerTitle}</strong><span class="who" id="who"></span></span>
          <button class="min-btn" id="min" type="button" aria-label="${s.minimizeLabel}" title="${s.minimizeLabel}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <line x1="6" y1="14" x2="18" y2="14"/>
            </svg>
          </button>
        </header>
        <div class="entry" id="entry">
          <h2>${s.entryTitle}</h2>
          <p>${s.entryQ}<br>${s.entryHelp}</p>
          <input id="entry-input" type="text" maxlength="40" placeholder="${s.entryPlaceholder}" autocomplete="off" />
          <p class="sub">${s.entryEmailLabel}</p>
          <input id="entry-email" type="email" maxlength="200" placeholder="${s.entryEmailPlaceholder}" autocomplete="email" />
          <button id="entry-button">${s.entryButton}</button>
        </div>
        <div class="log" id="log"></div>
        <form id="form">
          <div class="row">
            <div class="grow-wrap" id="wrap" data-replicated-value="">
              <textarea id="input" rows="3" placeholder="${s.inputPlaceholder}" disabled></textarea>
            </div>
            <button id="send" disabled>${s.sendButton}</button>
          </div>
          <div class="hint">${s.hintHtml}</div>
        </form>
      </div>
      </div>
    `;
    this.log = root.getElementById("log") as HTMLDivElement;
    this.input = root.getElementById("input") as HTMLTextAreaElement;
    this.inputWrap = root.getElementById("wrap") as HTMLDivElement;
    this.button = root.getElementById("send") as HTMLButtonElement;
    this.headerName = root.getElementById("who") as HTMLElement;
    this.panel = root.getElementById("panel") as HTMLDivElement;
    this.entryInput = root.getElementById("entry-input") as HTMLInputElement;
    this.entryEmail = root.getElementById("entry-email") as HTMLInputElement;
    this.entryButton = root.getElementById("entry-button") as HTMLButtonElement;
    this.wrap = root.getElementById("wrap-root") as HTMLDivElement;
    this.launcher = root.getElementById("launcher") as HTMLButtonElement;
    this.minBtn = root.getElementById("min") as HTMLButtonElement;
    const startOpen = localStorage.getItem(this.openStorageKey) === "1";
    this.setOpen(startOpen);
    this.launcher.addEventListener("click", () => this.setOpen(true));
    this.minBtn.addEventListener("click", () => this.setOpen(false));

    const tryEntrySubmit = (e: Event): void => {
      e.preventDefault();
      const wasFocused = this.shadowRoot?.activeElement === this.entryInput;
      if (wasFocused) this.entryInput.blur();
      requestAnimationFrame(() => this.submitEntry());
    };
    this.entryButton.addEventListener("mousedown", tryEntrySubmit);
    this.entryButton.addEventListener("mouseup", tryEntrySubmit);
    this.entryButton.addEventListener("click", tryEntrySubmit);
    this.entryButton.addEventListener("keyup", (e) => {
      if (e.code === "Enter") tryEntrySubmit(e);
    });
    this.entryButton.addEventListener("touchstart", tryEntrySubmit, { passive: false });

    const form = root.getElementById("form") as HTMLFormElement;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      this.submit();
    });
    const trySubmit = (e: Event): void => {
      if (this.button.disabled) return;
      e.preventDefault();
      const wasFocused = this.shadowRoot?.activeElement === this.input;
      if (wasFocused) this.input.blur();
      requestAnimationFrame(() => {
        this.submit();
        if (wasFocused) this.input.focus();
      });
    };
    this.button.addEventListener("mousedown", trySubmit);
    this.button.addEventListener("mouseup", trySubmit);
    this.button.addEventListener("click", trySubmit);
    this.button.addEventListener("keyup", (e) => {
      if (e.code === "Enter") trySubmit(e);
    });
    this.button.addEventListener("touchstart", trySubmit, { passive: false });
    const syncReplicated = (): void => {
      this.inputWrap.dataset.replicatedValue = this.input.value;
    };
    this.input.addEventListener("input", syncReplicated);
    this.input.addEventListener("compositionend", syncReplicated);
    this.input.addEventListener("keydown", (e) => {
      if (e.code === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.submit();
      }
    });
  }

  private setOpen(open: boolean): void {
    this.wrap.classList.toggle("open", open);
    localStorage.setItem(this.openStorageKey, open ? "1" : "0");
    if (open && !this.panel.classList.contains("entering") && !this.input.disabled) {
      requestAnimationFrame(() => this.input.focus());
    } else if (open && this.panel.classList.contains("entering")) {
      requestAnimationFrame(() => this.entryInput.focus());
    }
  }

  private enterChat(hasHistory: boolean): void {
    this.panel.classList.remove("entering");
    this.input.disabled = false;
    this.button.disabled = false;
    if (hasHistory) {
      this.appendStatus(this.strings.statusLoadingHistory);
    } else {
      this.appendIntro();
    }
    this.input.focus();
  }

  private renderName(): void {
    this.headerName.textContent = this.nickname ? `${this.nickname}${this.strings.nicknameSuffix}` : "";
  }

  private submitEntry(): void {
    const nickname = this.entryInput.value.trim();
    if (!nickname || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const email = this.entryEmail.value.trim();
    if (email && !v.safeParse(EmailSchema, email).success) {
      this.entryEmail.setCustomValidity(this.strings.emailInvalid);
      this.entryEmail.reportValidity();
      this.entryEmail.setCustomValidity("");
      this.entryEmail.focus();
      return;
    }
    this.ws.send(JSON.stringify({
      type: "set_nickname",
      nickname,
      email: email || null,
    }));
  }

  private submit(): void {
    const text = this.input.value.trim();
    if (!text || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "message", text }));
    this.input.value = "";
    this.inputWrap.dataset.replicatedValue = "";
  }

  private readSignedToken(): string | null {
    try {
      const params = new URLSearchParams(location.search);
      const t = params.get("dt");
      if (!t) return null;
      params.delete("dt");
      const qs = params.toString();
      const clean = location.pathname + (qs ? `?${qs}` : "") + location.hash;
      history.replaceState(null, "", clean);
      this.setOpen(true);
      return t;
    } catch {
      return null;
    }
  }

  private connect(url: string): void {
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.addEventListener("open", () => {
      const stored = localStorage.getItem(this.storageKey);
      const target = this.getAttribute("target");
      const siteId = this.getAttribute("site-id");
      const signedToken = this.readSignedToken();
      const pageUrl = location.origin + location.pathname;
      ws.send(JSON.stringify({
        type: "hello",
        locale: this.locale,
        pageUrl,
        ...(target ? { target } : {}),
        ...(siteId ? { siteId } : {}),
        ...(stored ? { visitorId: stored } : {}),
        ...(signedToken ? { signedToken } : {}),
      }));
    });
    ws.addEventListener("message", (e) => {
      const frame = JSON.parse(e.data) as ServerFrame;
      this.handle(frame);
    });
    ws.addEventListener("close", () => {
      this.appendStatus(this.strings.statusDisconnected);
      this.input.disabled = true;
      this.button.disabled = true;
    });
    ws.addEventListener("error", () => {
      this.appendStatus(this.strings.statusError("network"));
    });
  }

  private handle(frame: ServerFrame): void {
    if (frame.type === "welcome") {
      this.emojis = frame.emojis ?? {};
      this.nickname = frame.nickname;
      localStorage.setItem(this.storageKey, frame.visitorId);
      this.renderName();
      if (!frame.nickname) {
        this.panel.classList.add("entering");
        this.entryInput.focus();
      } else {
        this.enterChat(frame.hasHistory);
      }
      return;
    }
    if (frame.type === "message") {
      this.appendMessage(frame);
      return;
    }
    if (frame.type === "history_end") {
      this.appendStatus(this.strings.statusHistoryEnd);
      return;
    }
    if (frame.type === "nickname_updated") {
      if (!frame.nickname) return;
      this.nickname = frame.nickname;
      this.renderName();
      if (this.panel.classList.contains("entering")) {
        this.enterChat(/* hasHistory */ false);
      }
      return;
    }
    if (frame.type === "error") {
      this.appendStatus(this.strings.statusError(frame.reason));
    }
  }

  private appendMessage(m: MessageFrame): void {
    const el = document.createElement("div");
    el.className = `msg ${m.from}`;
    if (m.from === "agent" && m.senderName) {
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = m.senderName;
      el.appendChild(who);
    }
    this.renderTextWithEmoji(el, m.text);
    twemoji.parse(el, {
      folder: "svg",
      ext: ".svg",
      base: "https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/",
    });
    const time = document.createElement("time");
    time.className = "time";
    time.dateTime = new Date(m.ts).toISOString();
    time.textContent = this.formatTime(m.ts);
    el.appendChild(time);
    this.log.appendChild(el);
    this.log.scrollTop = this.log.scrollHeight;
  }

  private formatTime(ts: number): string {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const tag = this.locale === "ko" ? "ko-KR" : "ja-JP";
    if (sameDay) {
      return d.toLocaleTimeString(tag, { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleString(tag, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  private renderTextWithEmoji(parent: HTMLElement, text: string): void {
    const re = /:([a-z0-9_+-]+):/gi;
    let last = 0;
    for (const m of text.matchAll(re)) {
      const name = m[1]!;
      const url = this.emojis[name];
      const idx = m.index!;
      if (idx > last) parent.appendChild(document.createTextNode(text.slice(last, idx)));
      if (url) {
        const img = document.createElement("img");
        img.src = url;
        img.alt = `:${name}:`;
        img.title = `:${name}:`;
        img.className = "inline-emoji";
        parent.appendChild(img);
      } else {
        parent.appendChild(document.createTextNode(m[0]));
      }
      last = idx + m[0].length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  private appendIntro(): void {
    const el = document.createElement("div");
    el.className = "intro";
    el.innerHTML = this.strings.introHtml;
    twemoji.parse(el, {
      folder: "svg",
      ext: ".svg",
      base: "https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/",
    });
    this.log.appendChild(el);
  }

  private appendStatus(text: string): void {
    const el = document.createElement("div");
    el.className = "status";
    el.textContent = text;
    this.log.appendChild(el);
    this.log.scrollTop = this.log.scrollHeight;
  }
}

customElements.define("danro-talk", DanroTalk);
