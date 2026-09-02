export enum IpcChannel {
  App_GetCacheSize = 'app:get-cache-size',
  App_ClearCache = 'app:clear-cache',
  App_SetLaunchOnBoot = 'app:set-launch-on-boot',
  App_SetLanguage = 'app:set-language',
  App_SetEnableSpellCheck = 'app:set-enable-spell-check',
  App_SetSpellCheckLanguages = 'app:set-spell-check-languages',
  App_CheckForUpdate = 'app:check-for-update',
  App_QuitAndInstall = 'app:quit-and-install',
  App_Reload = 'app:reload',
  App_Quit = 'app:quit',
  App_Info = 'app:info',
  App_Proxy = 'app:proxy',
  App_SetLaunchToTray = 'app:set-launch-to-tray',
  App_SetTray = 'app:set-tray',
  App_SetTrayOnClose = 'app:set-tray-on-close',
  App_SetTheme = 'app:set-theme',
  App_SetAutoUpdate = 'app:set-auto-update',
  App_SetTestPlan = 'app:set-test-plan',
  App_SetTestChannel = 'app:set-test-channel',
  App_HandleZoomFactor = 'app:handle-zoom-factor',
  App_Select = 'app:select',
  App_HasWritePermission = 'app:has-write-permission',
  App_ResolvePath = 'app:resolve-path',
  App_IsPathInside = 'app:is-path-inside',
  App_Copy = 'app:copy',
  App_SetStopQuitApp = 'app:set-stop-quit-app',
  App_SetAppDataPath = 'app:set-app-data-path',
  App_GetDataPathFromArgs = 'app:get-data-path-from-args',
  App_FlushAppData = 'app:flush-app-data',
  App_IsNotEmptyDir = 'app:is-not-empty-dir',
  App_RelaunchApp = 'app:relaunch-app',
  App_ResetData = 'app:reset-data',
  App_IsBinaryExist = 'app:is-binary-exist',
  App_GetBinaryPath = 'app:get-binary-path',
  App_InstallUvBinary = 'app:install-uv-binary',
  App_InstallBunBinary = 'app:install-bun-binary',
  App_LogToMain = 'app:log-to-main',
  App_SaveData = 'app:save-data',
  App_GetDiskInfo = 'app:get-disk-info',
  App_SetFullScreen = 'app:set-full-screen',
  App_IsFullScreen = 'app:is-full-screen',
  App_GetSystemFonts = 'app:get-system-fonts',
  App_GetIpCountry = 'app:get-ip-country',
  APP_CrashRenderProcess = 'app:crash-render-process',

  App_MacIsProcessTrusted = 'app:mac-is-process-trusted',
  App_MacRequestProcessTrust = 'app:mac-request-process-trust',

  App_QuoteToMain = 'app:quote-to-main',
  App_SetDisableHardwareAcceleration = 'app:set-disable-hardware-acceleration',
  App_SetUseSystemTitleBar = 'app:set-use-system-title-bar',

  Notification_Send = 'notification:send',
  Notification_OnClick = 'notification:on-click',

  Webview_SetOpenLinkExternal = 'webview:set-open-link-external',
  Webview_SetSpellCheckEnabled = 'webview:set-spell-check-enabled',
  Webview_SearchHotkey = 'webview:search-hotkey',
  Webview_PrintToPDF = 'webview:print-to-pdf',
  Webview_SaveAsHTML = 'webview:save-as-html',

  // Open
  Open_Path = 'open:path',
  Open_Website = 'open:website',

  Minapp = 'minapp',

  Config_Set = 'config:set',
  Config_Get = 'config:get',

  // Mcp
  Mcp_AddServer = 'mcp:add-server',
  Mcp_RemoveServer = 'mcp:remove-server',
  Mcp_RestartServer = 'mcp:restart-server',
  Mcp_StopServer = 'mcp:stop-server',
  Mcp_ListTools = 'mcp:list-tools',
  Mcp_CallTool = 'mcp:call-tool',
  Mcp_ListPrompts = 'mcp:list-prompts',
  Mcp_GetPrompt = 'mcp:get-prompt',
  Mcp_ListResources = 'mcp:list-resources',
  Mcp_GetResource = 'mcp:get-resource',
  Mcp_GetInstallInfo = 'mcp:get-install-info',
  Mcp_ServersChanged = 'mcp:servers-changed',
  Mcp_ServersUpdated = 'mcp:servers-updated',
  Mcp_CheckConnectivity = 'mcp:check-connectivity',
  Mcp_UploadDxt = 'mcp:upload-dxt',
  Mcp_AbortTool = 'mcp:abort-tool',
  Mcp_ResolveHubTool = 'mcp:resolve-hub-tool',
  Mcp_GetServerVersion = 'mcp:get-server-version',
  Mcp_Progress = 'mcp:progress',
  Mcp_GetServerLogs = 'mcp:get-server-logs',
  Mcp_ServerLog = 'mcp:server-log',
  // Python
  Python_Execute = 'python:execute',

  //copilot
  Copilot_GetAuthMessage = 'copilot:get-auth-message',
  Copilot_GetCopilotToken = 'copilot:get-copilot-token',
  Copilot_SaveCopilotToken = 'copilot:save-copilot-token',
  Copilot_GetToken = 'copilot:get-token',
  Copilot_Logout = 'copilot:logout',
  Copilot_GetUser = 'copilot:get-user',

  // obsidian
  Obsidian_GetVaults = 'obsidian:get-vaults',
  Obsidian_GetFiles = 'obsidian:get-files',

  // nutstore
  Nutstore_GetSsoUrl = 'nutstore:get-sso-url',
  Nutstore_DecryptToken = 'nutstore:decrypt-token',
  Nutstore_GetDirectoryContents = 'nutstore:get-directory-contents',

  //aes
  Aes_Encrypt = 'aes:encrypt',
  Aes_Decrypt = 'aes:decrypt',

  Gemini_UploadFile = 'gemini:upload-file',
  Gemini_Base64File = 'gemini:base64-file',
  Gemini_RetrieveFile = 'gemini:retrieve-file',
  Gemini_ListFiles = 'gemini:list-files',
  Gemini_DeleteFile = 'gemini:delete-file',

  // VertexAI
  VertexAI_GetAuthHeaders = 'vertexai:get-auth-headers',
  VertexAI_GetAccessToken = 'vertexai:get-access-token',
  VertexAI_ClearAuthCache = 'vertexai:clear-auth-cache',

  Windows_ResetMinimumSize = 'window:reset-minimum-size',
  Windows_SetMinimumSize = 'window:set-minimum-size',
  Windows_Resize = 'window:resize',
  Windows_GetSize = 'window:get-size',
  Windows_Minimize = 'window:minimize',
  Windows_Maximize = 'window:maximize',
  Windows_Unmaximize = 'window:unmaximize',
  Windows_Close = 'window:close',
  Windows_IsMaximized = 'window:is-maximized',
  Windows_MaximizedChanged = 'window:maximized-changed',
  Windows_NavigateToAbout = 'window:navigate-to-about',

  KnowledgeBase_Create = 'knowledge-base:create',
  KnowledgeBase_Reset = 'knowledge-base:reset',
  KnowledgeBase_Delete = 'knowledge-base:delete',
  KnowledgeBase_Add = 'knowledge-base:add',
  KnowledgeBase_Remove = 'knowledge-base:remove',
  KnowledgeBase_Search = 'knowledge-base:search',
  KnowledgeBase_Rerank = 'knowledge-base:rerank',

  //file
  File_Open = 'file:open',
  File_OpenPath = 'file:openPath',
  File_Save = 'file:save',
  File_Select = 'file:select',
  File_Upload = 'file:upload',
  File_Clear = 'file:clear',
  File_Read = 'file:read',
  File_ReadExternal = 'file:readExternal',
  File_Delete = 'file:delete',
  File_DeleteDir = 'file:deleteDir',
  File_DeleteExternalFile = 'file:deleteExternalFile',
  File_DeleteExternalDir = 'file:deleteExternalDir',
  File_Move = 'file:move',
  File_MoveDir = 'file:moveDir',
  File_Rename = 'file:rename',
  File_RenameDir = 'file:renameDir',
  File_Get = 'file:get',
  File_SelectFolder = 'file:selectFolder',
  File_CreateTempFile = 'file:createTempFile',
  File_Mkdir = 'file:mkdir',
  File_Write = 'file:write',
  File_WriteWithId = 'file:writeWithId',
  File_SaveImage = 'file:saveImage',
  File_Base64Image = 'file:base64Image',
  File_Base64ImageExternal = 'file:base64ImageExternal',
  File_SaveBase64Image = 'file:saveBase64Image',
  File_SavePastedImage = 'file:savePastedImage',
  File_Download = 'file:download',
  File_Copy = 'file:copy',
  File_BinaryImage = 'file:binaryImage',
  File_Base64File = 'file:base64File',
  File_GetPdfInfo = 'file:getPdfInfo',
  File_GetPdfInfoExternal = 'file:getPdfInfoExternal',
  File_GetImageSize = 'file:getImageSize',
  File_GetImageSizeExternal = 'file:getImageSizeExternal',
  Fs_Read = 'fs:read',
  Fs_ReadText = 'fs:readText',
  File_OpenWithRelativePath = 'file:openWithRelativePath',
  File_IsTextFile = 'file:isTextFile',
  File_IsDirectory = 'file:isDirectory',
  File_ListDirectory = 'file:listDirectory',
  File_GetDirectoryStructure = 'file:getDirectoryStructure',
  File_CheckFileName = 'file:checkFileName',
  File_ValidateNotesDirectory = 'file:validateNotesDirectory',
  File_StartWatcher = 'file:startWatcher',
  File_StopWatcher = 'file:stopWatcher',
  File_PauseWatcher = 'file:pauseWatcher',
  File_ResumeWatcher = 'file:resumeWatcher',
  File_BatchUploadMarkdown = 'file:batchUploadMarkdown',
  File_ShowInFolder = 'file:showInFolder',
  File_Exists = 'file:exists',

  // PDF
  Pdf_ExtractText = 'pdf:extractText',

  // file service
  FileService_Upload = 'file-service:upload',
  FileService_List = 'file-service:list',
  FileService_Delete = 'file-service:delete',
  FileService_Retrieve = 'file-service:retrieve',

  Export_Word = 'export:word',

  Shortcuts_Update = 'shortcuts:update',

  // backup
  Backup_Backup = 'backup:backup',
  Backup_Restore = 'backup:restore',
  Backup_BackupToWebdav = 'backup:backupToWebdav',
  Backup_RestoreFromWebdav = 'backup:restoreFromWebdav',
  Backup_ListWebdavFiles = 'backup:listWebdavFiles',
  Backup_CheckConnection = 'backup:checkConnection',
  Backup_CreateDirectory = 'backup:createDirectory',
  Backup_DeleteWebdavFile = 'backup:deleteWebdavFile',
  Backup_BackupToLocalDir = 'backup:backupToLocalDir',
  Backup_RestoreFromLocalBackup = 'backup:restoreFromLocalBackup',
  Backup_ListLocalBackupFiles = 'backup:listLocalBackupFiles',
  Backup_DeleteLocalBackupFile = 'backup:deleteLocalBackupFile',
  Backup_BackupToS3 = 'backup:backupToS3',
  Backup_RestoreFromS3 = 'backup:restoreFromS3',
  Backup_ListS3Files = 'backup:listS3Files',
  Backup_DeleteS3File = 'backup:deleteS3File',
  Backup_CheckS3Connection = 'backup:checkS3Connection',

  // zip
  Zip_Compress = 'zip:compress',
  Zip_Decompress = 'zip:decompress',

  // system
  System_GetDeviceType = 'system:getDeviceType',
  System_GetHostname = 'system:getHostname',
  System_GetCpuName = 'system:getCpuName',
  System_CheckGitBash = 'system:checkGitBash',
  System_GetGitBashPath = 'system:getGitBashPath',
  System_GetGitBashPathInfo = 'system:getGitBashPathInfo',
  System_SetGitBashPath = 'system:setGitBashPath',

  // DevTools
  System_ToggleDevTools = 'system:toggleDevTools',

  // events
  BackupProgress = 'backup-progress',
  ThemeUpdated = 'theme:updated',
  RestoreProgress = 'restore-progress',
  UpdateError = 'update-error',
  UpdateAvailable = 'update-available',
  UpdateNotAvailable = 'update-not-available',
  DownloadProgress = 'download-progress',
  UpdateDownloaded = 'update-downloaded',
  DownloadUpdate = 'download-update',

  DirectoryProcessingPercent = 'directory-processing-percent',

  FullscreenStatusChanged = 'fullscreen-status-changed',

  ReduxStoreReady = 'redux-store-ready',

  // Search Window
  SearchWindow_Open = 'search-window:open',
  SearchWindow_Close = 'search-window:close',
  SearchWindow_OpenUrl = 'search-window:open-url',

  //Store Sync
  StoreSync_Subscribe = 'store-sync:subscribe',
  StoreSync_Unsubscribe = 'store-sync:unsubscribe',
  StoreSync_OnUpdate = 'store-sync:on-update',
  StoreSync_BroadcastSync = 'store-sync:broadcast-sync',

  // Provider
  Provider_AddKey = 'provider:add-key',

  // Memory
  Memory_Add = 'memory:add',
  Memory_Search = 'memory:search',
  Memory_List = 'memory:list',
  Memory_Delete = 'memory:delete',
  Memory_Update = 'memory:update',
  Memory_Get = 'memory:get',
  Memory_SetConfig = 'memory:set-config',
  Memory_DeleteUser = 'memory:delete-user',
  Memory_DeleteAllMemoriesForUser = 'memory:delete-all-memories-for-user',
  Memory_GetUsersList = 'memory:get-users-list',
  Memory_MigrateMemoryDb = 'memory:migrate-memory-db',

  // TRACE
  TRACE_SAVE_DATA = 'trace:saveData',
  TRACE_GET_DATA = 'trace:getData',
  TRACE_SAVE_ENTITY = 'trace:saveEntity',
  TRACE_GET_ENTITY = 'trace:getEntity',
  TRACE_BIND_TOPIC = 'trace:bindTopic',
  TRACE_CLEAN_TOPIC = 'trace:cleanTopic',
  TRACE_TOKEN_USAGE = 'trace:tokenUsage',
  TRACE_CLEAN_HISTORY = 'trace:cleanHistory',
  TRACE_OPEN_WINDOW = 'trace:openWindow',
  TRACE_SET_TITLE = 'trace:setTitle',
  TRACE_ADD_END_MESSAGE = 'trace:addEndMessage',
  TRACE_CLEAN_LOCAL_DATA = 'trace:cleanLocalData',
  TRACE_ADD_STREAM_MESSAGE = 'trace:addStreamMessage',

  // API Server
  ApiServer_Start = 'api-server:start',
  ApiServer_Stop = 'api-server:stop',
  ApiServer_Restart = 'api-server:restart',
  ApiServer_GetStatus = 'api-server:get-status',
  ApiServer_Ready = 'api-server:ready',
  // NOTE: This api is not be used.
  ApiServer_GetConfig = 'api-server:get-config',

  // Anthropic OAuth
  Anthropic_StartOAuthFlow = 'anthropic:start-oauth-flow',
  Anthropic_CompleteOAuthWithCode = 'anthropic:complete-oauth-with-code',
  Anthropic_CancelOAuthFlow = 'anthropic:cancel-oauth-flow',
  Anthropic_GetAccessToken = 'anthropic:get-access-token',
  Anthropic_HasCredentials = 'anthropic:has-credentials',
  Anthropic_ClearCredentials = 'anthropic:clear-credentials',

  // ExternalApps
  ExternalApps_DetectInstalled = 'external-apps:detect-installed',

  // OCR
  OCR_ocr = 'ocr:ocr',
  OCR_ListProviders = 'ocr:list-providers',

  // Analytics
  Analytics_TrackTokenUsage = 'analytics:track-token-usage',

  // ChatDB — command-oriented IPC for SQLite message persistence
  // Maps 1:1 to ChatDbAggregateService capabilities (renderer → Main).
  // updateFileCount(s) excluded — stays in Dexie/FileManager.
  ChatDb_FetchMessages = 'chatdb:fetch-messages',
  ChatDb_FetchMessagesWindow = 'chatdb:fetch-messages-window',
  ChatDb_GetRawTopic = 'chatdb:get-raw-topic',
  ChatDb_TopicExists = 'chatdb:topic-exists',
  ChatDb_EnsureTopic = 'chatdb:ensure-topic',
  ChatDb_AppendMessage = 'chatdb:append-message',
  ChatDb_UpdateMessage = 'chatdb:update-message',
  ChatDb_UpdateMessageAndBlocks = 'chatdb:update-message-and-blocks',
  // PERF-100: one atomic multi-model answer-tab selection (foldSelected group switch)
  ChatDb_SelectAnswerMessage = 'chatdb:select-answer-message',
  ChatDb_DeleteMessage = 'chatdb:delete-message',
  ChatDb_DeleteMessages = 'chatdb:delete-messages',
  ChatDb_UpdateBlocks = 'chatdb:update-blocks',
  ChatDb_UpdateSingleBlock = 'chatdb:update-single-block',
  ChatDb_BulkAddBlocks = 'chatdb:bulk-add-blocks',
  ChatDb_DeleteBlocks = 'chatdb:delete-blocks',

  // Phase 5.1A — segment, reorder, and file-reference relationship queries
  ChatDb_ListSegments = 'chatdb:list-segments',
  ChatDb_UpsertSegment = 'chatdb:upsert-segment',
  ChatDb_UpdateSegmentMetadata = 'chatdb:update-segment-metadata',
  ChatDb_DeleteSegment = 'chatdb:delete-segment',
  ChatDb_ReplaceSegmentMembership = 'chatdb:replace-segment-membership',
  ChatDb_ReorderMessages = 'chatdb:reorder-messages',
  ChatDb_ListFileRefsByFile = 'chatdb:list-file-refs-by-file',
  ChatDb_CountFileRefsByFile = 'chatdb:count-file-refs-by-file',
  ChatDb_ListBlocksByFile = 'chatdb:list-blocks-by-file',

  // Phase 5.1B — topic lifecycle
  ChatDb_UpdateTopicMetadata = 'chatdb:update-topic-metadata',
  ChatDb_SoftDeleteTopic = 'chatdb:soft-delete-topic',
  ChatDb_RestoreTopic = 'chatdb:restore-topic',
  ChatDb_ListTrashTopics = 'chatdb:list-trash-topics',
  ChatDb_HardDeleteTopic = 'chatdb:hard-delete-topic',
  ChatDb_PurgeExpiredTopics = 'chatdb:purge-expired-topics',

  // Phase 5.2B — atomic assistant empty-trash (LOCK-531)
  ChatDb_EmptyTrashTopics = 'chatdb:empty-trash-topics',
  ChatDb_TransferTopicOwnership = 'chatdb:transfer-topic-ownership',
  ChatDb_ResetAssistantTopics = 'chatdb:reset-assistant-topics',

  // S6.2c-1 — Main-authoritative branch by stable anchor
  ChatDb_BranchMessagesToTopic = 'chatdb:branch-messages-to-topic',

  // S6.2c-2 — Main-authoritative insert after stable anchor
  ChatDb_InsertMessagesAfterAnchor = 'chatdb:insert-messages-after-anchor',

  // Phase 5.1B — compound mutations
  ChatDb_CloneMessagesToTopic = 'chatdb:clone-messages-to-topic',
  ChatDb_ResetMessagesForResend = 'chatdb:reset-messages-for-resend',
  ChatDb_DeleteMessagesWithSegments = 'chatdb:delete-messages-with-segments',
  ChatDb_PasteMessagesToTopic = 'chatdb:paste-messages-to-topic',

  // Phase 5.1B-2 — search
  ChatDb_SearchMessages = 'chatdb:search-messages',

  // S6.2b R-05 — authoritative answer-group READ
  ChatDb_FetchAnswerGroup = 'chatdb:fetch-answer-group',

  // S6.3 R-06 — authoritative context closure READ (anchor through newest)
  ChatDb_FetchContextClosure = 'chatdb:fetch-context-closure',

  // Phase 5 authoritative deletion propagation — Main → all renderers
  ChatDb_TopicDeleted = 'chatdb:topic-deleted',

  // ChatImport — import-only IPC for Phase 4 source-reader pipeline.
  // Independent of the ChatDb_* channels. Prefix: chat-import:*
  ChatImport_Ready = 'chat-import:ready',
  ChatImport_Discover = 'chat-import:discover',
  ChatImport_ReadPage = 'chat-import:read-page',
  ChatImport_Cancel = 'chat-import:cancel',
  ChatImport_Complete = 'chat-import:complete',
  ChatImport_Error = 'chat-import:error',
  // ChatImport_Projection — renderer → main: source Local Storage
  // `persist:cherry-studio` payload for the L2 navigation projection
  // (LOCK-PROD-2/6). Main-only parse/validation; never crosses IPC back.
  ChatImport_Projection = 'chat-import:projection',

  // CherryImport — L2 Cherry Studio ZIP compatibility-import control IPC.
  // Command-oriented bridge from the main renderer to the Phase 4 import
  // service. Independent of the 6 ChatImport_* channels (source-reader
  // pipeline) and the Backup_* channels (L3 backup/restore). Prefix:
  // cherry-import:*
  CherryImport_GetPlatformSupport = 'cherry-import:get-platform-support',
  CherryImport_Start = 'cherry-import:start',
  CherryImport_Cancel = 'cherry-import:cancel',
  CherryImport_GetStatus = 'cherry-import:get-status',
  CherryImport_StatusChanged = 'cherry-import:status-changed',
  // L2 one-shot navigation projection (LOCK-PROD-6): renderer reads the
  // pending projection after Redux rehydration, applies it, flushes, then
  // durably acks so a crash-before-ack retries on next startup.
  CherryImport_GetProjection = 'cherry-import:get-projection',
  CherryImport_AckProjection = 'cherry-import:ack-projection',
  // L2 files catalog handoff boundary (Phase 2, LOCK-PROMO-5/7): Main →
  // renderer request events and the renderer → Main typed response invoke.
  // The renderer owns the only handle to the live Dexie files table, so
  // Main drives capture/apply/restore/query through this minimal boundary.
  // The main renderer's MAIN FRAME only; ordinary UI is blocked while the
  // catalog-pending apply/recovery is in flight.
  // LOCK-BRIDGE-1: renderer → main ready handshake. The recovery renderer
  // invokes this ONLY after its catalog request handler is installed (App
  // mount after PersistGate); Main awaits it with a bounded timeout before
  // sending any catalog request so the recovery window never races the
  // handler registration (the previous 60s per-request timeout race).
  CherryImport_CatalogRequest = 'cherry-import:catalog-request',
  CherryImport_CatalogRespond = 'cherry-import:catalog-respond',
  CherryImport_CatalogReady = 'cherry-import:catalog-ready',

  // Sync — app-level operation log + HTTP relay (MVP)
  Sync_GetConfig = 'sync:get-config',
  Sync_SetConfig = 'sync:set-config',
  Sync_GetStatus = 'sync:get-status',
  Sync_Sync = 'sync:sync'
}
