import { t } from "../i18n/index.js";
import { ItemView, TFile, setIcon, type WorkspaceLeaf } from "obsidian";
import { actionIcon, actionLabel, dayLabel, displayPath, entryKind, fromBase64, timeLabel } from "@websync/shared";
import type SyncstonePlugin from "../main.js";
import { baseName, formatBytes } from "./historyFormat.js";
import { authorsLabel, groupEdits, mixesAccounts, toHistoryEntry, type HistoryEntry } from "./historyGroups.js";

export const HISTORY_VIEW_TYPE = "syncstone-history";

/**
 * Version history in the sidebar (right by default, movable like any Obsidian view) - the same panel as in the web
 * workspace: the versions of the active file (or of the file picked via t("p.history") in its menu) with diff,
 * restore and "save as copy", or the change log of the whole vault.
 */
export class HistoryView extends ItemView {
  private mode: "file" | "vault" = "file";
  /** A file picked via the file menu; it wins until another file becomes active. */
  private pin: { fileId: string; activePath: string | null } | null = null;
  private entries: HistoryEntry[] = [];
  /** Edit blocks the user opened, by the id of their newest version. */
  private expanded = new Set<string>();
  private nextBefore: number | null = null;
  private retentionDays = 0;
  private loading = false;
  private error: string | null = null;
  private selectedId: string | null = null;
  private loadedFor: string | null = null;
  private query = "";
  private onlyDeleted = false;
  private showSettings = false;
  private request = 0;
  private reloadTimer: number | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: SyncstonePlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return HISTORY_VIEW_TYPE;
  }

  getDisplayText(): string {
    return t("p.history");
  }

  getIcon(): string {
    return "history";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("syncstone-history");
    this.registerEvent(this.app.workspace.on("file-open", () => this.mode === "file" && void this.reload()));
    // After an edit the upload runs a moment later (debounce + transfer): look again once it had time to land.
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (this.mode === "file" && file.path === this.app.workspace.getActiveFile()?.path) this.scheduleReload(5000);
      }),
    );
    await this.reload();
  }

  async onClose(): Promise<void> {
    if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
  }

  /** Called from the file menu / commands: shows `file`'s versions (or the active file's). */
  async showFile(file?: TFile | null): Promise<void> {
    this.mode = "file";
    this.pin = null;
    const active = this.app.workspace.getActiveFile()?.path ?? null;
    if (file && file.path !== active) {
      const id = await this.fileIdOf(file.path);
      if (id) this.pin = { fileId: id, activePath: active };
    }
    await this.reload(true);
  }

  /** Sync (re)started or stopped: the view may have shown "not connected" so far. */
  refresh(): void {
    void this.reload();
  }

  async showVault(): Promise<void> {
    this.mode = "vault";
    await this.reload(true);
  }

  private scheduleReload(ms: number): void {
    if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
    this.reloadTimer = window.setTimeout(() => {
      this.reloadTimer = null;
      void this.reload();
    }, ms);
  }

  // ------------------------------------------------------------------
  // Data
  // ------------------------------------------------------------------

  private get vaultId(): string | null {
    return this.plugin.settings.linkedVault?.vaultId ?? null;
  }

  private async fileIdOf(path: string): Promise<string | null> {
    try {
      return (await this.plugin.localIndex?.getByPath(path))?.fileId ?? null;
    } catch {
      return null;
    }
  }

  /** File id the t("p.modeFile") mode shows, or null (no file / file not synced yet). */
  private async targetFileId(): Promise<string | null> {
    const active = this.app.workspace.getActiveFile()?.path ?? null;
    if (this.pin && this.pin.activePath === active) return this.pin.fileId;
    this.pin = null;
    return active ? this.fileIdOf(active) : null;
  }

  private async reload(force = false): Promise<void> {
    const vaultId = this.vaultId;
    if (!vaultId || !this.plugin.cryptoService.isUnlocked() || !this.plugin.localIndex) {
      this.entries = [];
      this.error = t("p.notConnected");
      this.render();
      return;
    }
    const fileId = this.mode === "file" ? await this.targetFileId() : null;
    const key = this.mode === "file" ? `file:${fileId}` : "vault";
    if (key !== this.loadedFor || force) this.selectedId = null;
    this.loadedFor = key;
    if (this.mode === "file" && !fileId) {
      this.entries = [];
      this.error = null;
      this.loading = false;
      this.render();
      return;
    }
    await this.loadPage(vaultId, fileId ?? undefined);
  }

  private async loadPage(vaultId: string, fileId?: string, before?: number): Promise<void> {
    const id = ++this.request;
    this.loading = true;
    this.error = null;
    this.render();
    try {
      const page = await this.plugin.remoteApi.getHistory(vaultId, fileId, before);
      const decrypted = await Promise.all(
        page.revisions.map(async (r): Promise<HistoryEntry> => {
          let path: string | null = null;
          try {
            path = await this.plugin.cryptoService.decryptPath(fromBase64(r.pathCiphertext), fromBase64(r.pathNonce));
          } catch {
            /* shown as unreadable */
          }
          return toHistoryEntry(r, path);
        }),
      );
      if (id !== this.request) return;
      this.entries = before ? [...this.entries, ...decrypted] : decrypted;
      this.nextBefore = page.nextBefore;
      this.retentionDays = page.retentionDays;
    } catch (err) {
      if (id === this.request) this.error = err instanceof Error ? err.message : t("p.historyLoadFailed");
    } finally {
      if (id === this.request) {
        this.loading = false;
        this.render();
      }
    }
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  private render(): void {
    const el = this.contentEl;
    el.empty();

    const toggle = el.createDiv({ cls: "syncstone-history-toggle" });
    for (const [mode, label] of [
      ["file", t("p.modeFile")],
      ["vault", t("p.modeVault")],
    ] as const) {
      const button = toggle.createEl("button", { text: label, cls: this.mode === mode ? "is-active" : "" });
      button.onclick = () => {
        this.mode = mode;
        void this.reload(true);
      };
    }

    if (this.mode === "file") this.renderFile(el);
    else this.renderVault(el);

    if (this.loading) el.createDiv({ cls: "syncstone-history-empty", text: t("p.loading") });
    if (this.error) el.createDiv({ cls: "syncstone-history-empty mod-error", text: this.error });
    if (this.nextBefore && !this.loading) {
      const more = el.createEl("button", { cls: "syncstone-history-more", text: t("p.loadOlder") });
      more.onclick = () => {
        const vaultId = this.vaultId;
        if (!vaultId || !this.nextBefore) return;
        void this.targetFileId().then((fileId) => this.loadPage(vaultId, this.mode === "file" ? (fileId ?? undefined) : undefined, this.nextBefore ?? undefined));
      };
    }
    if (this.retentionDays > 0) {
      el.createDiv({
        cls: "syncstone-history-footer",
        text:
          this.mode === "file"
            ? t("p.footerFile", { days: this.retentionDays })
            : t("p.footerVault", { days: this.retentionDays }),
      });
    }
  }

  private renderFile(el: HTMLElement): void {
    const first = this.entries[0];
    const active = this.app.workspace.getActiveFile();
    if (!first && !this.loading && !this.error) {
      el.createDiv({
        cls: "syncstone-history-empty",
        text: active ? t("p.noHistory") : t("p.noFile"),
      });
      return;
    }
    if (!first) return;

    const title = el.createDiv({ cls: "syncstone-history-title" });
    const path = this.pin || !active ? displayPath(first) : active.path;
    title.createSpan({ cls: "syncstone-history-name", text: baseName(path), attr: { title: path } });
    if (first.action === "delete") title.createSpan({ cls: "syncstone-history-faint", text: t("p.deletedSuffix") });
    const refresh = title.createDiv({ cls: "clickable-icon", attr: { "aria-label": t("p.reload") } });
    setIcon(refresh, "refresh-cw");
    refresh.onclick = () => void this.reload();

    const accounts = mixesAccounts(this.entries);
    const unknown = t("history.unknownDevice");
    const list = el.createDiv({ cls: "syncstone-history-list" });
    const blocks = groupEdits(this.entries);
    blocks.forEach((block, blockIndex) => {
      const newest = block[0];
      const oldest = block[block.length - 1];
      const isBlock = block.length > 1;
      const open = isBlock && this.expanded.has(newest.id);
      const selected = block.some((entry) => entry.id === this.selectedId);
      const row = list.createDiv({ cls: `syncstone-history-item${selected && (!open || newest.id === this.selectedId) ? " is-selected" : ""}` });
      setIcon(row.createDiv({ cls: `syncstone-history-icon is-${newest.action}` }), actionIcon(newest));
      const body = row.createDiv({ cls: "syncstone-history-body" });
      const when = isBlock
        ? `${dayLabel(newest.createdAt)}, ${timeLabel(oldest.createdAt)}–${timeLabel(newest.createdAt)}`
        : `${dayLabel(newest.createdAt)}, ${timeLabel(newest.createdAt)}`;
      const head = body.createDiv({ cls: "syncstone-history-line", text: when });
      if (blockIndex === 0 && newest.action !== "delete") head.createSpan({ cls: "syncstone-history-badge", text: t("p.current") });
      const what = isBlock ? t("p.versionsCount", { count: block.length }) : actionLabel(newest);
      const size = newest.action !== "rename" && newest.action !== "delete" ? ` · ${formatBytes(newest.size)}` : "";
      body.createDiv({ cls: "syncstone-history-note", text: `${what} · ${authorsLabel(block, accounts, unknown)}${size}` });
      row.onclick = () => {
        this.selectedId = newest.id;
        this.render();
        void this.plugin.openRevisionDiff(newest.fileId, newest.id);
      };
      if (!isBlock) return;
      const chevron = row.createDiv({ cls: "syncstone-history-expand clickable-icon", attr: { "aria-label": open ? t("p.collapse") : t("p.expand") } });
      setIcon(chevron, open ? "chevron-down" : "chevron-right");
      chevron.onclick = (event) => {
        event.stopPropagation();
        if (open) this.expanded.delete(newest.id);
        else this.expanded.add(newest.id);
        this.render();
      };
      if (!open) return;
      // The single versions of the block, indented under it: each one opens like any other version.
      for (const entry of block) {
        const sub = list.createDiv({ cls: `syncstone-history-item is-sub${entry.id === this.selectedId ? " is-selected" : ""}` });
        const subBody = sub.createDiv({ cls: "syncstone-history-body" });
        subBody.createDiv({ cls: "syncstone-history-note", text: `${timeLabel(entry.createdAt)} · ${authorsLabel([entry], accounts, unknown)} · ${formatBytes(entry.size)}` });
        sub.onclick = () => {
          this.selectedId = entry.id;
          this.render();
          void this.plugin.openRevisionDiff(entry.fileId, entry.id);
        };
      }
    });
  }

  private renderVault(el: HTMLElement): void {
    const filters = el.createDiv({ cls: "syncstone-history-filters" });
    const searchRow = filters.createDiv({ cls: "syncstone-history-title" });
    const search = searchRow.createEl("input", { type: "search", placeholder: t("p.filter"), value: this.query });
    const refresh = searchRow.createDiv({ cls: "clickable-icon", attr: { "aria-label": t("p.reload") } });
    setIcon(refresh, "refresh-cw");
    refresh.onclick = () => void this.reload();
    search.oninput = () => {
      this.query = search.value;
      this.renderVaultList(listHost);
    };
    for (const [key, label] of [
      ["onlyDeleted", t("p.onlyDeleted")],
      ["showSettings", t("p.settings")],
    ] as const) {
      const wrap = filters.createEl("label", { cls: "syncstone-history-check" });
      const box = wrap.createEl("input", { type: "checkbox" });
      box.checked = this[key];
      box.onchange = () => {
        this[key] = box.checked;
        this.renderVaultList(listHost);
      };
      wrap.appendText(` ${label}`);
    }
    const listHost = el.createDiv({ cls: "syncstone-history-list" });
    this.renderVaultList(listHost);
  }

  private renderVaultList(host: HTMLElement): void {
    host.empty();
    const q = this.query.trim().toLowerCase();
    const accounts = mixesAccounts(this.entries);
    const unknown = t("history.unknownDevice");
    let day = "";
    let shown = 0;
    const visible = this.entries.filter((entry) => {
      const kind = entryKind(entry);
      if (!this.showSettings && kind === "settings") return false;
      if (this.onlyDeleted && entry.action !== "delete") return false;
      const path = displayPath(entry);
      return !q || path.toLowerCase().includes(q) || authorsLabel([entry], true, unknown).toLowerCase().includes(q);
    });
    for (const block of groupEdits(visible)) {
      const entry = block[0];
      const oldest = block[block.length - 1];
      const kind = entryKind(entry);
      const path = displayPath(entry);
      const label = dayLabel(entry.createdAt);
      if (label !== day) {
        day = label;
        host.createDiv({ cls: "syncstone-history-day", text: label });
      }
      shown++;
      const row = host.createDiv({ cls: "syncstone-history-item" });
      setIcon(row.createDiv({ cls: `syncstone-history-icon is-${entry.action}` }), actionIcon(entry));
      const body = row.createDiv({ cls: "syncstone-history-body" });
      body.createDiv({ cls: `syncstone-history-line${entry.action === "delete" ? " is-deleted" : ""}`, text: path, attr: { title: path } });
      const when = block.length > 1 ? `${timeLabel(oldest.createdAt)}–${timeLabel(entry.createdAt)}` : timeLabel(entry.createdAt);
      const what = block.length > 1 ? t("p.versionsCount", { count: block.length }) : actionLabel(entry);
      body.createDiv({ cls: "syncstone-history-note", text: `${when} · ${what} · ${authorsLabel(block, accounts, unknown)}` });
      if (kind !== "folder") {
        row.onclick = () => {
          this.mode = "file";
          this.pin = { fileId: entry.fileId, activePath: this.app.workspace.getActiveFile()?.path ?? null };
          this.selectedId = entry.id;
          void this.reload(true);
          void this.plugin.openRevisionDiff(entry.fileId, entry.id);
        };
      }
    }
    if (shown === 0 && !this.loading && !this.error) {
      host.createDiv({ cls: "syncstone-history-empty", text: this.entries.length === 0 ? t("p.noChanges") : t("p.noMatches") });
    }
  }
}
