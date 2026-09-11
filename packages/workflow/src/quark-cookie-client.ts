/**
 * Quark (夸克网盘) HTTP client — the brand-2 analogue of Pan115CookieClient.
 * Cookie auth at `drive-pc.quark.cn`, JSON bodies, response shape
 * `{code, message, data}` where `code===0` is success. All endpoints below were
 * captured live (see the quark spec) — no signature params (kps/sign/vcode) are
 * needed, the cookie alone authenticates.
 *
 * 转存 (the 115-秒传 equivalent) is a 4-step chain: share token → share detail →
 * save → poll task. Magnet/offline has NO web API on quark, so it lives in the
 * executor's fail-loud path, not here.
 */

import { fetchWithTimeout } from "./fetch-with-timeout.js";

const QUARK_BASE_URL = "https://drive-pc.quark.cn";
// Fixed query every quark pc-web call carries. uc_param_str is intentionally empty.
const QUARK_BASE_QUERY = "pr=ucpro&fr=pc&uc_param_str=";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124 Safari/537.36";
const DEFAULT_LIST_PAGE_SIZE = 50;
const DEFAULT_POLL_ATTEMPTS = 12;
const DEFAULT_POLL_DELAY_MS = 800;
const DEFAULT_HTTP_TIMEOUT_MS = 20_000;

/** Quark's "require login" code — the dead-cookie signal (HTTP 401, code 31001). */
const QUARK_AUTH_CODE = 31001;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface QuarkHttpInit {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export type QuarkFetchJson = (url: string, init: QuarkHttpInit) => Promise<unknown>;

export interface QuarkCookieClientOptions {
  cookie: string;
  fetchJson?: QuarkFetchJson;
  userAgent?: string;
  /** Injectable sleep between task-poll attempts (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  pollAttempts?: number;
  pollDelayMs?: number;
}

/** pollTask 的结果。`done:false` = 轮询耗尽仍未到 status===2 —— 也就是
 *  「任务没完成但调用方照常往下走」。改这个返回值就是为了让它可见:此前
 *  awaitTaskFrom 直接丢掉 boolean,move/delete 没真正完成也会被当成功。 */
export interface QuarkTaskPollResult {
  done: boolean;
  /** 实际轮询了几次(status===2 命中那次计入)。 */
  attempts: number;
  /** 最后一次读到的 task status;读不到为 null。 */
  lastStatus: number | null;
}

/** A directory listing entry (file/sort). `dir:true` = directory. */
export interface QuarkItem {
  fid?: string;
  file_name?: string;
  dir?: boolean;
  size?: number | string;
  file_type?: number;
}

/** A share-detail entry — carries the share_fid_token needed to save it. */
export interface QuarkShareItem extends QuarkItem {
  share_fid_token?: string;
}

/**
 * The cookie is dead (logged in elsewhere / expired). Quark signals this as
 * HTTP 401 + `{code:31001, message:"require login [guest]"}`. Distinct from a
 * bad-param failure so the worker can FREEZE the drive on this specifically.
 * Mirrors Pan115AuthError.
 */
export class QuarkAuthError extends Error {
  readonly code: number | null;
  constructor(message: string, code: number | null = null) {
    super(message);
    this.name = "QuarkAuthError";
    this.code = code;
  }
}

export function isQuarkAuthError(error: unknown): error is QuarkAuthError {
  return error instanceof QuarkAuthError;
}

export class QuarkCookieClient {
  private readonly cookie: string;
  private readonly fetchJson: QuarkFetchJson;
  private readonly userAgent: string;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly pollAttempts: number;
  private readonly pollDelayMs: number;

  constructor(options: QuarkCookieClientOptions) {
    const cookie = normalizeCookie(options.cookie);
    if (!cookie) {
      throw new Error("QUARK_COOKIE is required to create QuarkCookieClient");
    }
    this.cookie = cookie;
    this.fetchJson = options.fetchJson ?? defaultFetchJson;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.sleepFn = options.sleep ?? sleep;
    this.pollAttempts = options.pollAttempts ?? DEFAULT_POLL_ATTEMPTS;
    this.pollDelayMs = options.pollDelayMs ?? DEFAULT_POLL_DELAY_MS;
  }

  /** Immediate children of a directory (file/sort, one page; size covers a media leaf). */
  async listItems(input: { directoryId: string; page?: number; size?: number }): Promise<QuarkItem[]> {
    const response = await this.getJson("/1/clouddrive/file/sort", [
      ["pdir_fid", input.directoryId],
      ["_page", String(input.page ?? 1)],
      ["_size", String(input.size ?? DEFAULT_LIST_PAGE_SIZE)],
      ["_fetch_total", "1"],
      ["_sort", "file_type:asc,updated_at:desc,file_name:asc"],
    ]);
    const data = unwrap(response, "QUARK_LIST_ITEMS_FAILED");
    return listFrom(data);
  }


  /** 分页遍历到底(listAllItems / listAllShareDetail 共用):按 fid 去重,直到某页
   *  没有新增或不足一页;512 页硬上限兜住忽略 _page 的坏接口。
   *  为什么必须去重:夸克 /file/sort 按 `file_type:asc,updated_at:desc` 排序,批量转存
   *  会给几百个文件同一个 updated_at,并列顺序不稳定 → 两次独立调用的分页边界可能
   *  重叠、或漏掉边界上的一个文件(同一个暂存目录两次列出来不一样,moveToSeason 的
   *  范围守卫因此误报「文件不在暂存」)。去重 + 逐页重扫能把边界文件捞回来。 */
  private async listAllPages<T extends { fid?: string }>(
    size: number,
    fetchPage: (page: number, size: number) => Promise<T[]>,
  ): Promise<T[]> {
    const seen = new Map<string, T>();
    let page = 1;
    for (;;) {
      const items = await fetchPage(page, size);
      let added = 0;
      for (const item of items) {
        const id = item.fid;
        if (id === undefined) continue;
        if (!seen.has(id)) {
          seen.set(id, item);
          added += 1;
        }
      }
      if (added === 0 || items.length < size) break;
      page += 1;
      if (page > 512) break;
    }
    return [...seen.values()];
  }

  /** All immediate children of a directory, paginating through every page.
   *  listItems only returns ONE page (default size 50), so directories with more
   *  than one page of children were silently truncated (source shares were never
   *  fully transferred / inspected). */
  async listAllItems(input: { directoryId: string; size?: number }): Promise<QuarkItem[]> {
    return this.listAllPages(input.size ?? DEFAULT_LIST_PAGE_SIZE, (page, size) =>
      this.listItems({ directoryId: input.directoryId, page, size }),
    );
  }

  /** A single file/directory's identity incl. its immediate parent (pdir_fid).
   *  Quark has no one-shot breadcrumb, so the executor walks pdir_fid up to a
   *  write-scope root with these calls. */
  async getFileInfo(fid: string): Promise<{ fid: string; file_name: string; pdir_fid: string; dir: boolean }> {
    const response = await this.getJson("/1/clouddrive/file/info", [["fid", fid]]);
    const data = unwrap(response, "QUARK_FILE_INFO_FAILED");
    return {
      fid: stringValue(recordValue(data, "fid")),
      file_name: stringValue(recordValue(data, "file_name")),
      pdir_fid: stringValue(recordValue(data, "pdir_fid")),
      dir: recordValue(data, "dir") === true,
    };
  }

  async createFolder(input: { name: string; parentId: string }): Promise<string> {
    const response = await this.postJson("/1/clouddrive/file", {
      pdir_fid: input.parentId,
      file_name: input.name,
      dir_path: "",
      dir_init_lock: false,
    });
    const data = unwrap(response, "QUARK_CREATE_FOLDER_FAILED");
    const fid = stringValue(recordValue(data, "fid"));
    if (!fid) {
      throw new Error("QUARK_CREATE_FOLDER_FAILED: response missing data.fid");
    }
    return fid;
  }

  /** Step 1 of 转存: exchange a share's pwd_id + passcode for an stoken. */
  async getShareToken(input: { pwd_id: string; passcode: string }): Promise<string> {
    const response = await this.postJson("/1/clouddrive/share/sharepage/token", {
      pwd_id: input.pwd_id,
      passcode: input.passcode,
    });
    const data = unwrap(response, "QUARK_SHARE_TOKEN_FAILED");
    const stoken = stringValue(recordValue(data, "stoken"));
    if (!stoken) {
      throw new Error("QUARK_SHARE_TOKEN_FAILED: response missing data.stoken");
    }
    return stoken;
  }

  /** Step 2: list the files inside a share (each carries share_fid_token for save). */
  async listShareDetail(input: {
    pwd_id: string;
    stoken: string;
    pdirFid?: string;
    page?: number;
    size?: number;
  }): Promise<QuarkShareItem[]> {
    const response = await this.getJson("/1/clouddrive/share/sharepage/detail", [
      ["pwd_id", input.pwd_id],
      ["stoken", input.stoken],
      ["pdir_fid", input.pdirFid ?? "0"],
      ["force", "0"],
      ["_page", String(input.page ?? 1)],
      ["_size", String(input.size ?? DEFAULT_LIST_PAGE_SIZE)],
      ["_fetch_banner", "0"],
      ["_fetch_share", "0"],
      ["_fetch_total", "1"],
      ["_sort", "file_type:asc,updated_at:desc,file_name:asc"],
    ]);
    const data = unwrap(response, "QUARK_SHARE_DETAIL_FAILED");
    return listFrom(data) as QuarkShareItem[];
  }


  /** All files inside a share, paginating through every page. listShareDetail
   *  returns ONE page (default size 50); a share with more items only ever
   *  transferred the first page unless we loop here. */
  async listAllShareDetail(input: {
    pwd_id: string;
    stoken: string;
    pdirFid?: string;
    size?: number;
  }): Promise<QuarkShareItem[]> {
    return this.listAllPages(input.size ?? DEFAULT_LIST_PAGE_SIZE, (page, size) =>
      this.listShareDetail({
        pwd_id: input.pwd_id,
        stoken: input.stoken,
        ...(input.pdirFid !== undefined ? { pdirFid: input.pdirFid } : {}),
        page,
        size,
      }),
    );
  }

  /** Step 3: save selected share files into a destination directory; returns task_id. */
  async saveShare(input: {
    fid_list: string[];
    fid_token_list: string[];
    to_pdir_fid: string;
    pwd_id: string;
    stoken: string;
    pdirFid?: string;
  }): Promise<string> {
    const response = await this.postJson("/1/clouddrive/share/sharepage/save", {
      fid_list: input.fid_list,
      fid_token_list: input.fid_token_list,
      to_pdir_fid: input.to_pdir_fid,
      pwd_id: input.pwd_id,
      stoken: input.stoken,
      pdir_fid: input.pdirFid ?? "0",
      scene: "link",
    });
    const data = unwrap(response, "QUARK_SHARE_SAVE_FAILED");
    const taskId = stringValue(recordValue(data, "task_id"));
    if (!taskId) {
      throw new Error("QUARK_SHARE_SAVE_FAILED: response missing data.task_id");
    }
    return taskId;
  }

  /** Step 4: poll the async task until status===2 (done). false if it never completes. */
  async pollTask(taskId: string, opts?: { maxAttempts?: number }): Promise<QuarkTaskPollResult> {
    const maxAttempts = opts?.maxAttempts ?? this.pollAttempts;
    let lastStatus: number | null = null;
    for (let i = 0; i < maxAttempts; i++) {
      const response = await this.getJson("/1/clouddrive/task", [
        ["task_id", taskId],
        ["retry_index", String(i)],
      ]);
      const data = unwrap(response, "QUARK_TASK_FAILED");
      const status = numberValue(recordValue(data, "status"));
      lastStatus = Number.isFinite(status) ? status : null;
      if (status === 2) {
        return { done: true, attempts: i + 1, lastStatus };
      }
      await this.sleepFn(this.pollDelayMs);
    }
    return { done: false, attempts: maxAttempts, lastStatus };
  }

  /** Delete files (action_type:2 = move to recycle bin, same as 115's rb/delete).
   *  Async on quark — returns a task_id we poll to completion. */
  async deleteFiles(fids: string[]): Promise<void> {
    const response = await this.postJson("/1/clouddrive/file/delete", {
      action_type: 2,
      filelist: fids,
      exclude_fids: [],
    });
    await this.awaitTaskFrom(response, "QUARK_DELETE_FAILED");
  }

  /** Move files. Async on quark — returns a task_id we poll to completion so the
   *  move is reflected before the caller re-reads the destination. */
  async moveFiles(input: { fids: string[]; to: string }): Promise<void> {
    const response = await this.postJson("/1/clouddrive/file/move", {
      filelist: input.fids,
      to_pdir_fid: input.to,
      exclude_fids: [],
      action_type: 1,
    });
    await this.awaitTaskFrom(response, "QUARK_MOVE_FAILED");
  }

  /** Unwrap a task-returning response and poll its task_id to completion (if any). */
  private async awaitTaskFrom(response: unknown, genericPrefix: string): Promise<void> {
    const data = unwrap(response, genericPrefix);
    const taskId = stringValue(recordValue(data, "task_id"));
    if (!taskId) {
      // 无 task_id = 该操作这次是同步的,或夸克这次没走异步。
      return;
    }
    const t0 = Date.now();
    const result = await this.pollTask(taskId);
    if (result.done) {
      return;
    }
    // ⚠ 任务没到完成态,调用方却照常往下走——「move 假成功」最可能的来源。
    // 只留痕不 throw:轮询耗尽也可能只是夸克 status 语义与我们假设不同,
    // 先拿到数据定性,再决定是否 fail-loud。
    console.warn(
      `[quark] ⚠ 异步任务未完成 ${genericPrefix} task=${taskId.slice(0, 12)}… 轮询 ${result.attempts} 次仍未到 status=2(最后 status=${result.lastStatus ?? "N/A"}),耗时 ${Date.now() - t0}ms —— 调用方仍按成功继续`,
    );
  }

  async renameFile(input: { fid: string; name: string }): Promise<void> {
    const response = await this.postJson("/1/clouddrive/file/rename", {
      fid: input.fid,
      file_name: input.name,
    });
    // 返回值只用于判定 code:0。响应体不含 fid(实测 data={})——夸克 rename
    // 不换 fid(run 82a02640:34 条入参 fid 全部保留,名字全部变更),所以调用方
    // 无需也不应依赖响应里的新 id。
    unwrap(response, "QUARK_RENAME_FAILED");
  }

  private async getJson(path: string, params: Array<[string, string]>): Promise<unknown> {
    const query = new URLSearchParams(QUARK_BASE_QUERY);
    for (const [key, value] of params) {
      query.set(key, value);
    }
    return this.fetchJson(`${QUARK_BASE_URL}${path}?${query.toString()}`, {
      method: "GET",
      headers: this.headers(),
    });
  }

  private async postJson(path: string, body: unknown): Promise<unknown> {
    return this.fetchJson(`${QUARK_BASE_URL}${path}?${QUARK_BASE_QUERY}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
  }

  private headers(): Record<string, string> {
    return {
      Cookie: this.cookie,
      "User-Agent": this.userAgent,
      Referer: "https://pan.quark.cn/",
      Origin: "https://pan.quark.cn",
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
    };
  }
}

/** Extract the stable quark account id from a cookie (`__uid=` preferred, `__kps=`
 *  fallback — both carry the same opaque per-account token). Keys the
 *  instance-wide UNIQUE(provider, provider_uid). */
export function parseQuarkUid(cookie: string): string | null {
  const uid = /(?:^|;|\s)__uid=([^;]+)/.exec(cookie);
  if (uid?.[1]) {
    return uid[1].trim();
  }
  const kps = /(?:^|;|\s)__kps=([^;]+)/.exec(cookie);
  return kps?.[1] ? kps[1].trim() : null;
}

async function defaultFetchJson(url: string, init: QuarkHttpInit): Promise<unknown> {
  const requestInit: RequestInit = { method: init.method, headers: init.headers };
  if (init.body !== undefined) {
    requestInit.body = init.body;
  }
  const response = await fetchWithTimeout(url, requestInit, DEFAULT_HTTP_TIMEOUT_MS);
  // Quark returns its {code:31001} auth body WITH HTTP 401, so parse the JSON
  // regardless of status — the code (not the HTTP status) is the real signal.
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`QUARK_HTTP_FAILED: ${response.status}`);
  }
}

/**
 * Assert `code===0` and return `data`. On the auth code (31001) throw
 * QuarkAuthError so the drive can be frozen; on any other non-zero code throw a
 * generic Error carrying the server message (fail-loud — never a silent success).
 */
function unwrap(response: unknown, genericPrefix: string): unknown {
  const code = numberValue(recordValue(response, "code"));
  if (code === 0) {
    return recordValue(response, "data");
  }
  const message = responseMessage(response);
  if (isAuthFailure(code, message)) {
    throw new QuarkAuthError(`QUARK_AUTH_FAILED: ${message}`, code);
  }
  throw new Error(`${genericPrefix}: code=${code} ${message}`);
}

function isAuthFailure(code: number, message: string): boolean {
  if (code === QUARK_AUTH_CODE) {
    return true;
  }
  return /require login|未登录|登录|登陆|relogin/i.test(message);
}

function responseMessage(response: unknown): string {
  return stringValue(recordValue(response, "message") ?? recordValue(response, "msg"));
}

function listFrom(data: unknown): QuarkItem[] {
  return arrayValue(recordValue(data, "list")).filter(isRecord) as QuarkItem[];
}

function normalizeCookie(cookie: string | undefined): string {
  const trimmed = cookie?.trim() ?? "";
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function recordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
