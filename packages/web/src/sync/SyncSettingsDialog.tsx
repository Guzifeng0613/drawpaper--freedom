import * as React from 'react';
import {
  Cloud,
  Folder,
  Globe,
  Lock,
  RefreshCw,
  Trash2,
  Package,
  Download,
  Upload,
  AlertTriangle,
  Sparkles,
} from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { useSyncUi } from './sync-ui-store';
import { syncController, MIN_WEBDAV_POLL_MS } from './sync-controller';
import { pickRealDirectory, isFsaDirectorySupported } from './directory-handle';
import type { WebDavConfig } from './webdav';
import { exportAllToKbpackBlob, downloadBlob, importKbpackBundle } from './kbpack-transfer';
import { ConflictCopiesDialog } from './ConflictCopiesDialog';
import {
  isNativeAutosaveRuntime,
  getNativeAutosaveDir,
  pickNativeAutosaveFolder,
  clearNativeAutosaveFolder,
} from '@/host/native-autosave-adapter';

/**
 * 设置 → 同步面板（Wave10 阶段 B 两通道；Wave11 阶段 A WebDAV 端到端加密；
 * Wave11 阶段 B 三通道引导 + 手动备份包 + 冲突副本处理）。
 *
 * 三通道（互斥）：
 *  ① 同步文件夹（FSA，showDirectoryPicker）
 *  ② WebDAV（含阶段 A 端到端加密开关/口令交互，控件与 testid 原样保留）
 *  ③ 手动备份包（.kbpack 导出/导入合并，零网络；无 FSA 浏览器默认推荐高亮）
 *
 * 首次打开出可跳过引导弹层（localStorage 记录跳过状态）。
 */
const MIN_PASS_LEN = 8;
const ONBOARD_KEY = 'drawpaper-sync:onboarded';

export function SyncSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ui = useSyncUi();
  const [webdavUrl, setWebdavUrl] = React.useState('');
  const [webdavUser, setWebdavUser] = React.useState('');
  const [webdavPass, setWebdavPass] = React.useState('');
  const [pollOn, setPollOn] = React.useState(false);

  // ---- Wave11 E2EE 本地态 ----
  const [e2eeOn, setE2eeOn] = React.useState(ui.e2eeEnabled);
  const [e2eePass, setE2eePass] = React.useState('');
  const [e2eeConfirm, setE2eeConfirm] = React.useState('');
  const [e2eeRemember, setE2eeRemember] = React.useState(false);
  const [e2eeError, setE2eeError] = React.useState('');
  const [unlockPass, setUnlockPass] = React.useState('');
  const [changingPass, setChangingPass] = React.useState(false);
  const [newPass, setNewPass] = React.useState('');
  const [newPassConfirm, setNewPassConfirm] = React.useState('');

  // ---- Wave11 阶段 B：首次引导 + 冲突面板 + 手动包 ----
  const [showOnboard, setShowOnboard] = React.useState(false);
  const [conflictOpen, setConflictOpen] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // Wave17：桌面自动保存文件夹（仅 Tauri 内显示；浏览器整组渲染 null）。
  const nativeAutosaveOn = isNativeAutosaveRuntime();
  const [nativeDir, setNativeDir] = React.useState<string | null>(null);

  const fsaSupported = isFsaDirectorySupported();

  // 打开面板时：若首次 → 出引导弹层；顺带刷新冲突副本计数。
  React.useEffect(() => {
    if (!open) return;
    void ui.refreshConflictCopies();
    if (nativeAutosaveOn) void getNativeAutosaveDir().then(setNativeDir);
    let seen = false;
    try {
      seen = localStorage.getItem(ONBOARD_KEY) === '1';
    } catch {
      /* ignore */
    }
    if (!seen) setShowOnboard(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const dismissOnboard = () => {
    try {
      localStorage.setItem(ONBOARD_KEY, '1');
    } catch {
      /* ignore */
    }
    setShowOnboard(false);
  };

  const isHttp = webdavUrl.startsWith('http://');

  const chooseFolder = async () => {
    const handle = await pickRealDirectory();
    if (!handle) return;
    syncController.startFolder(handle);
  };

  const saveWebdav = () => {
    const url = webdavUrl.trim().replace(/\/+$/, '');
    if (!url) return;
    if (e2eeOn) {
      if (e2eePass.length < MIN_PASS_LEN) {
        setE2eeError(`加密口令至少 ${MIN_PASS_LEN} 位`);
        return;
      }
      if (e2eePass !== e2eeConfirm) {
        setE2eeError('两次输入的加密口令不一致');
        return;
      }
    }
    setE2eeError('');
    const config: WebDavConfig = { baseUrl: url, username: webdavUser, password: webdavPass };
    syncController.startWebdav(config, pollOn ? MIN_WEBDAV_POLL_MS : 0, {
      enabled: e2eeOn,
      passphrase: e2eeOn ? e2eePass : undefined,
      rememberSession: e2eeRemember,
    });
  };

  const doUnlock = async () => {
    if (!unlockPass) return;
    try {
      await syncController.unlockWebdav(unlockPass);
      setUnlockPass('');
    } catch {
      /* 错误口令已由 controller toast；保留输入框供重试 */
    }
  };

  const doChangePass = async () => {
    if (newPass.length < MIN_PASS_LEN) {
      setE2eeError(`新口令至少 ${MIN_PASS_LEN} 位`);
      return;
    }
    if (newPass !== newPassConfirm) {
      setE2eeError('两次输入的新口令不一致');
      return;
    }
    setE2eeError('');
    try {
      await syncController.changeWebdavPassphrase(newPass, e2eeRemember);
      setChangingPass(false);
      setNewPass('');
      setNewPassConfirm('');
    } catch (e) {
      setE2eeError((e as Error).message);
    }
  };

  const doExportBundle = async () => {
    ui.setBundleBusy(true);
    try {
      const { blob, filename } = await exportAllToKbpackBlob();
      downloadBlob(blob, filename);
    } finally {
      ui.setBundleBusy(false);
    }
  };

  const doImportBundle = async (file: File) => {
    ui.setBundleBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const summary = await importKbpackBundle(bytes);
      pushToastFromSummary(summary);
      await ui.refreshConflictCopies();
    } catch (e) {
      const msg = e instanceof Error ? e.message : '备份包损坏';
      useSyncUi.getState().setError(`导入备份包失败：${msg}`);
    } finally {
      ui.setBundleBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>同步</DialogTitle>
            <DialogDescription>
              跨设备同步，零托管、无官方服务器；数据只存在你选的文件夹、WebDAV，或你自己保存的备份包里。三通道互斥，同时只启用一个。
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3 text-sm">
            {/* 状态行 */}
            <div className="grid grid-cols-3 gap-2 rounded border bg-muted/40 px-3 py-2 text-center text-xs">
              <div>
                <div className="text-muted-foreground">上次同步</div>
                <div data-testid="sync-last-at">
                  {ui.lastSyncAt ? new Date(ui.lastSyncAt).toLocaleString() : '未同步'}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">推 / 拉</div>
                <div data-testid="sync-push-pull">
                  {ui.pushCount} / {ui.pullCount}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">待解决冲突</div>
                <div data-testid="sync-conflict-count">{ui.conflictCount}</div>
              </div>
            </div>

            {/* Wave17：桌面自动保存文件夹（仅 Tauri 桌面端显示；浏览器整组 null）。
                与「同步通道」互不强耦合——这是一条独立的本地磁盘 durability mirror，
                把 .kbnote+assets 镜像到用户选定的真实文件夹（Explorer 可见 / 可被
                OneDrive 同步），不影响既有 OPFS/IndexedDB 自动保存。 */}
            {nativeAutosaveOn ? (
              <div className="flex flex-col gap-2 rounded border p-3" data-testid="native-autosave-section">
                <div className="text-xs font-medium">自动保存到本机文件夹</div>
                <div className="text-[11px] text-muted-foreground">
                  {nativeDir
                    ? `已开启，文档与附件镜像到：${nativeDir}`
                    : '未开启：文档目前只保存在应用本地存储中。选一个真实文件夹后，每次编辑都会自动写入。'}
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      const dir = await pickNativeAutosaveFolder();
                      if (dir) setNativeDir(dir);
                    }}
                    data-testid="native-autosave-pick"
                  >
                    <Folder className="h-4 w-4" /> {nativeDir ? '更换文件夹' : '选择文件夹'}
                  </Button>
                  {nativeDir ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-destructive"
                      onClick={async () => {
                        await clearNativeAutosaveFolder();
                        setNativeDir(null);
                      }}
                      data-testid="native-autosave-clear"
                    >
                      <Trash2 className="h-4 w-4" /> 取消自动保存
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {/* 冲突副本入口 */}
            <Button
              size="sm"
              variant="outline"
              className="justify-start"
              onClick={() => setConflictOpen(true)}
              data-testid="open-conflict-panel"
            >
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              查看待处理冲突副本
              {ui.conflictCopiesCount > 0 ? (
                <span className="ml-auto rounded-full bg-amber-500/20 px-2 text-xs text-amber-700" data-testid="conflict-badge">
                  {ui.conflictCopiesCount}
                </span>
              ) : null}
            </Button>

            {/* 通道选择（三卡片引导） */}
            <div className="flex flex-col gap-2">
              <div className="text-xs font-medium text-muted-foreground">选择通道（互斥）</div>

              <label
                className={`flex items-start gap-2 rounded border px-2 py-1.5 ${!fsaSupported ? 'opacity-50' : ''}`}
                data-testid="channel-folder"
              >
                <input
                  type="radio"
                  name="sync-channel"
                  className="mt-1"
                  checked={ui.channel === 'folder'}
                  onChange={() => {
                    useSyncUi.getState().setChannel('folder');
                    void chooseFolder();
                  }}
                />
                <Folder className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="flex flex-col">
                  <span className="text-xs font-medium">同步文件夹</span>
                  <span className="text-[11px] text-muted-foreground">
                    {fsaSupported ? '选一个本地文件夹，自动双向同步' : '当前浏览器不支持目录选择'}
                  </span>
                </span>
              </label>

              <label className="flex items-start gap-2 rounded border px-2 py-1.5" data-testid="channel-webdav">
                <input
                  type="radio"
                  name="sync-channel"
                  className="mt-1"
                  checked={ui.channel === 'webdav'}
                  onChange={() => useSyncUi.getState().setChannel('webdav')}
                />
                <Globe className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="flex flex-col">
                  <span className="text-xs font-medium">WebDAV</span>
                  <span className="text-[11px] text-muted-foreground">
                    连你自己的 WebDAV 服务器，可选端到端加密
                  </span>
                </span>
              </label>

              <label
                className={`flex items-start gap-2 rounded border px-2 py-1.5 ${!fsaSupported ? 'border-primary bg-primary/5 ring-1 ring-primary' : ''}`}
                data-testid="channel-manual"
              >
                <input
                  type="radio"
                  name="sync-channel"
                  className="mt-1"
                  checked={ui.channel === 'manual'}
                  onChange={() => useSyncUi.getState().setChannel('manual')}
                />
                <Package className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="flex flex-1 flex-col">
                  <span className="flex items-center gap-1 text-xs font-medium">
                    手动备份包
                    {!fsaSupported ? (
                      <span className="rounded bg-primary px-1 text-[10px] text-primary-foreground" data-testid="manual-recommend">
                        推荐
                      </span>
                    ) : null}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    导出全部为单个 .kbpack，在另一台设备导入合并；完全离线
                  </span>
                </span>
              </label>
            </div>

            {ui.channel === 'folder' ? (
              <div className="flex flex-col gap-2 rounded border p-3">
                <div className="text-xs text-muted-foreground">
                  {ui.targetLabel || (fsaSupported ? '尚未选择目录' : '当前浏览器不支持目录选择，请用手动备份包')}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={chooseFolder} data-testid="pick-folder">
                    <Folder className="h-4 w-4" /> 选择同步目录
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void syncController.runNow()} disabled={ui.busy}>
                    <RefreshCw className="h-4 w-4" /> 立即同步
                  </Button>
                </div>
              </div>
            ) : null}

            {ui.channel === 'webdav' ? (
              <div className="flex flex-col gap-2 rounded border p-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="webdav-url">服务器地址</Label>
                  <Input
                    id="webdav-url"
                    placeholder="https://dav.example.com/drawpaper"
                    value={webdavUrl}
                    onChange={(e) => setWebdavUrl(e.target.value)}
                    data-testid="webdav-url"
                  />
                  {isHttp ? (
                    <div className="text-xs text-destructive" data-testid="http-warning">
                      警告：http 明文传输，凭据与文档不加密，仅建议本机/内网使用。
                    </div>
                  ) : null}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="webdav-user">用户名</Label>
                    <Input id="webdav-user" value={webdavUser} onChange={(e) => setWebdavUser(e.target.value)} data-testid="webdav-user" />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="webdav-pass">密码</Label>
                    <Input id="webdav-pass" type="password" value={webdavPass} onChange={(e) => setWebdavPass(e.target.value)} data-testid="webdav-pass" />
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="webdav-poll" className="text-xs text-muted-foreground">
                    定时轮询（下限 5 分钟，默认关）
                  </Label>
                  <Switch id="webdav-poll" checked={pollOn} onCheckedChange={setPollOn} />
                </div>

                {/* ---- Wave11 端到端加密 ---- */}
                <div className="flex items-center justify-between rounded border p-2">
                  <div className="flex items-center gap-2">
                    <Lock className="h-3.5 w-3.5 text-muted-foreground" />
                    <div className="flex flex-col">
                      <span className="text-xs font-medium">端到端加密</span>
                      <span className="text-[11px] text-muted-foreground">
                        开启后服务器只看到加密信封，无法读取文档标题与内容
                      </span>
                    </div>
                  </div>
                  <Switch
                    checked={e2eeOn}
                    onCheckedChange={(b) => {
                      setE2eeOn(b);
                      setE2eeError('');
                    }}
                    data-testid="e2ee-toggle"
                  />
                </div>

                {e2eeOn && !ui.e2eeActive && !ui.e2eeLocked ? (
                  <div className="flex flex-col gap-1.5 rounded border p-2" data-testid="e2ee-setup">
                    <div className="grid grid-cols-2 gap-2">
                      <div className="flex flex-col gap-1">
                        <Label htmlFor="e2ee-pass" className="text-xs">加密口令</Label>
                        <Input id="e2ee-pass" type="password" value={e2eePass} onChange={(e) => setE2eePass(e.target.value)} data-testid="e2ee-pass" />
                      </div>
                      <div className="flex flex-col gap-1">
                        <Label htmlFor="e2ee-confirm" className="text-xs">确认口令</Label>
                        <Input id="e2ee-confirm" type="password" value={e2eeConfirm} onChange={(e) => setE2eeConfirm(e.target.value)} data-testid="e2ee-confirm" />
                      </div>
                    </div>
                    <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <Checkbox checked={e2eeRemember} onCheckedChange={(v) => setE2eeRemember(v === true)} data-testid="e2ee-remember" />
                      记住本次会话（仅本标签页存活期间；关闭后每次刷新都需重输口令）
                    </label>
                  </div>
                ) : null}

                {ui.e2eeLocked ? (
                  <div className="flex flex-col gap-1.5 rounded border border-destructive/50 p-2" data-testid="e2ee-unlock-row">
                    <div className="text-xs text-destructive">端到端加密已开启：请输入口令解锁同步（不会把口令发给服务器）</div>
                    <div className="flex gap-2">
                      <Input
                        type="password"
                        placeholder="加密口令"
                        value={unlockPass}
                        onChange={(e) => setUnlockPass(e.target.value)}
                        data-testid="e2ee-unlock-pass"
                      />
                      <Button size="sm" onClick={() => void doUnlock()} data-testid="e2ee-unlock">
                        解锁并同步
                      </Button>
                    </div>
                  </div>
                ) : null}

                {ui.e2eeActive ? (
                  <div className="flex items-center justify-between rounded border bg-primary/5 p-2" data-testid="e2ee-active-row">
                    <span className="text-xs text-muted-foreground">端到端加密已启用（AES-256-GCM）</span>
                    <Button size="sm" variant="outline" onClick={() => setChangingPass(true)} data-testid="e2ee-change-pass">
                      更换口令
                    </Button>
                  </div>
                ) : null}

                {changingPass ? (
                  <div className="flex flex-col gap-1.5 rounded border p-2" data-testid="e2ee-change-row">
                    <div className="text-[11px] text-muted-foreground">
                      更换口令后，本端会把全部文档以新口令重新加密推送一份；旧设备需用新口令解锁。
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Input type="password" placeholder="新口令（≥8 位）" value={newPass} onChange={(e) => setNewPass(e.target.value)} data-testid="e2ee-new-pass" />
                      <Input type="password" placeholder="确认新口令" value={newPassConfirm} onChange={(e) => setNewPassConfirm(e.target.value)} data-testid="e2ee-new-confirm" />
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => void doChangePass()} data-testid="e2ee-change-confirm">确认更换并全量重推</Button>
                      <Button size="sm" variant="outline" onClick={() => setChangingPass(false)}>取消</Button>
                    </div>
                  </div>
                ) : null}

                {e2eeError ? <div className="text-xs text-destructive" data-testid="e2ee-error">{e2eeError}</div> : null}

                <div className="flex gap-2">
                  <Button size="sm" onClick={saveWebdav} data-testid="webdav-connect">
                    <Cloud className="h-4 w-4" /> 连接
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void syncController.runNow()} disabled={ui.busy || ui.e2eeLocked}>
                    <RefreshCw className="h-4 w-4" /> 立即同步
                  </Button>
                </div>
                {ui.error ? <div className="text-xs text-destructive" data-testid="webdav-error">{ui.error}</div> : null}
              </div>
            ) : null}

            {ui.channel === 'manual' ? (
              <div className="flex flex-col gap-2 rounded border p-3" data-testid="manual-panel">
                <div className="text-xs text-muted-foreground">
                  把全部文档与附件打包成单个 .kbpack 文件，拷到另一台设备后导入合并。全程离线、零网络。
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => void doExportBundle()} disabled={ui.bundleBusy} data-testid="bundle-export">
                    <Download className="h-4 w-4" /> 导出全部为备份包
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={ui.bundleBusy} data-testid="bundle-import">
                    <Upload className="h-4 w-4" /> 导入备份包并合并
                  </Button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".kbpack,application/octet-stream"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void doImportBundle(f);
                    }}
                    data-testid="bundle-import-input"
                  />
                </div>
                <div className="text-[11px] text-muted-foreground">
                  导入是合并而非覆盖：本端已有的文档会逐字段合并，新文档直接收入；附件自动回填。
                </div>
              </div>
            ) : null}

            {/* 停止同步 + 清除凭据 */}
            {ui.channel !== 'none' && ui.channel !== 'manual' ? (
              <Button
                size="sm"
                variant="outline"
                className="text-destructive"
                onClick={() => void syncController.stopAndClear()}
                data-testid="stop-sync"
              >
                <Trash2 className="h-4 w-4" /> 停止同步并清除凭据
              </Button>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      <ConflictCopiesDialog open={conflictOpen} onOpenChange={setConflictOpen} />

      {/* 首次引导弹层（可跳过） */}
      <Dialog open={showOnboard} onOpenChange={(o) => { if (!o) dismissOnboard(); }}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" /> 三步配置跨设备同步
            </DialogTitle>
          </DialogHeader>
          <ol className="flex flex-col gap-2 text-sm">
            <li className="rounded border p-2" data-testid="onboard-step-1">
              <span className="font-medium">① 选通道</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                同步文件夹（自动）、WebDAV（服务器），或手动备份包（离线导出/导入）。
              </span>
            </li>
            <li className="rounded border p-2" data-testid="onboard-step-2">
              <span className="font-medium">② 配置并连接</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                WebDAV 可选端到端加密；手动包导出后拷到另一台设备导入即可。
              </span>
            </li>
            <li className="rounded border p-2" data-testid="onboard-step-3">
              <span className="font-medium">③ 有冲突？</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                合并冲突会保留副本，在「待处理冲突副本」里预览、采纳或丢弃。
              </span>
            </li>
          </ol>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={dismissOnboard} data-testid="onboard-skip">
              跳过，我自己看
            </Button>
            <Button size="sm" onClick={dismissOnboard} data-testid="onboard-gotit">
              知道了
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function pushToastFromSummary(summary: {
  totalDocs: number;
  importedNew: number;
  merged: number;
  conflicts: number;
  assetsRestored: number;
  skippedAssets: number;
}): void {
  // 延迟引入避免循环；运行时 toast。
  import('@/panels/lib/toast').then(({ pushToast }) => {
    const base = `导入完成：新增 ${summary.importedNew}、合并 ${summary.merged} 个文档`;
    const assetNote =
      summary.skippedAssets > 0
        ? `，回填 ${summary.assetsRestored} 个附件；${summary.skippedAssets} 项资产因当前设备不支持 OPFS 未回填（以降级形态保留）`
        : `，回填 ${summary.assetsRestored} 个附件`;
    if (summary.conflicts > 0) {
      pushToast('warn', `${base}，${summary.conflicts} 处冲突待处理${assetNote}`);
    } else if (summary.skippedAssets > 0) {
      pushToast('warn', `${base}${assetNote}`);
    } else {
      pushToast('success', `${base}${assetNote}`);
    }
  }).catch(() => undefined);
}
