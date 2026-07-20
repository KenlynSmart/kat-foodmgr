const { createApp, ref, computed, watch, onMounted, nextTick } = Vue;

createApp({
  setup() {
    const API_BASE =
      window.__VN_FOOD_API_BASE__ ||
      localStorage.getItem('vn-food-api-base') ||
      (window.location.hostname.endsWith('github.io')
        ? 'https://kat-foodmgr-backend.onrender.com'
        : '');
    const STORAGE_KEY = 'vn-food-v2-state';
    const ACTIVE_VENDOR_STORAGE_KEY = 'vn-food-active-vendor';

    const today = new Date().toISOString().slice(0, 10);
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    const norm = (value) => String(value || '').trim().toLowerCase();
    const num = (value) => {
      const parsed = parseFloat(String(value ?? '').replace(',', '.'));
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const round3 = (value) => Math.round(num(value) * 1000) / 1000;
    const money = (value) => new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 }).format(Math.round(num(value))) + ' đ';
    const qty = (value) => new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 3 }).format(round3(value));
    const nowText = () => new Date().toLocaleString('vi-VN');

    const themes = [
      { label: 'Sky', bg_color: 'bg-sky-50', text_color: 'text-sky-800', border_color: 'border-sky-200' },
      { label: 'Emerald', bg_color: 'bg-emerald-50', text_color: 'text-emerald-800', border_color: 'border-emerald-200' },
      { label: 'Amber', bg_color: 'bg-amber-50', text_color: 'text-amber-800', border_color: 'border-amber-200' },
      { label: 'Rose', bg_color: 'bg-rose-50', text_color: 'text-rose-800', border_color: 'border-rose-200' },
      { label: 'Violet', bg_color: 'bg-violet-50', text_color: 'text-violet-800', border_color: 'border-violet-200' },
      { label: 'Cyan', bg_color: 'bg-cyan-50', text_color: 'text-cyan-800', border_color: 'border-cyan-200' }
    ];
    const iconOptions = ['fa-school', 'fa-seedling', 'fa-apple-whole', 'fa-mug-hot', 'fa-bowl-rice', 'fa-basket-shopping'];
    const themeMap = Object.fromEntries(themes.map((theme) => [theme.bg_color, theme]));

    const emptyRow = () => ({
      id: uid(),
      isDirty: false,
      shortcut: '',
      searchQuery: '',
      productName: '',
      unit: '',
      price: 0,
      schoolQtys: {},
      schoolBatches: {},
      schoolOrderIds: {},
      totalQty: 0,
      subTotal: 0,
      suggestions: [],
      suggestIndex: 0,
      showDropdown: false,
      showSuggestions: false,
      suggestionPosition: {}
    });

    const state = {
      rows: [emptyRow()],
      schools: [],
      categories: [],
      stockMap: {},
      deliveryDate: today
    };

    const schoolKey = (school) => String(school?.id || school?.code || '');
    const productKey = (product) => String(product?.id || product?.code || '');
    const resolveSchool = (value) => schools.value.find((school) => schoolKey(school) === String(value) || norm(school.code) === norm(value) || norm(school.id) === norm(value));
    const resolveProduct = (value) => products.value.find((product) => productKey(product) === String(value) || norm(product.code) === norm(value) || norm(product.id) === norm(value));
    const normalizeStockMap = (input) => Object.entries(input || {}).reduce((result, [key, value]) => {
      const product = resolveProduct(key);
      result[product?.id || key] = num(value);
      return result;
    }, {});
    const stockValue = (product) => num(stockMap.value[product?.id]);

    const currentTab = ref('matrix');
    const rows = ref(state.rows);
    const schools = ref(state.schools);
    const products = ref([]);
    const categories = ref(state.categories || []);
    const stockMap = ref(state.stockMap);
    const deliveryDate = ref(state.deliveryDate);
    const parserText = ref('');
    const parserPreview = ref([]);
    const notifications = ref([]);
    const toasts = notifications;
    const productFilter = ref('');
    const productCategoryFilter = ref('');
    const schoolFilter = ref('');
    const stockFilter = ref('');
    const matrixPage = ref(1);
    const stockPage = ref(1);
    const catalogPage = ref(1);
    const pageSize = 25;
    const syncStatus = ref('Đang tải');
    const dataOrigin = ref('Local cache');
    const statusBanner = ref('');
    const lastSyncAt = ref('');
    const isSyncingManual = ref(false);
    const authToken = ref(localStorage.getItem('auth_token') || '');
    const activeVendorId = ref(localStorage.getItem(ACTIVE_VENDOR_STORAGE_KEY) || '');
    const isAuthenticated = computed(() => Boolean(authToken.value));
    const currentUser = ref(null);
    const currentVendorName = computed(() => currentUser.value?.vendor_name || 'Hệ thống Quản trị');
    const users = ref([]);
    const pendingPinUsers = computed(() => users.value.filter((user) => user.temp_pin));
    const vendors = ref([]);
    const selectedVendorId = ref('');
    const vendorForm = ref({ code: '', name: '', status: 'active' });
    const vendorSaving = ref(false);
    const editingVendorId = ref('');
    const isAdmin = computed(() => currentUser.value?.role === 'admin');
    const subscriptionCodes = ref([]);
    const subscriptionMetrics = ref({ total_revenue: 0, active_paid_vendors: 0, generated_codes: 0, used_codes: 0 });
    const subscriptionCodeForm = ref({ duration_months: 1, price_allocated: 0 });
    const subscriptionCodeGenerating = ref(false);
    const renewalCode = ref('');
    const redeemingCode = ref(false);
    const subscriptionWarning = computed(() => {
      const dueDate = currentUser.value?.subscription_due_date;
      if (isAdmin.value || !dueDate) return null;
      const due = new Date(`${dueDate}T00:00:00`);
      const todayDate = new Date();
      todayDate.setHours(0, 0, 0, 0);
      const remainingDays = Math.ceil((due.getTime() - todayDate.getTime()) / 86400000);
      if (remainingDays > 15) return null;
      return {
        remainingDays: Math.max(remainingDays, 0),
        dueDate: new Intl.DateTimeFormat('vi-VN').format(due)
      };
    });
    const userRole = computed(() => currentUser.value?.role || 'staff');
    const canManageCatalog = computed(() => ['admin', 'owner', 'manager'].includes(userRole.value));
    const canMutate = computed(() => userRole.value !== 'report-viewer');
    const mustChangePassword = ref(false);
    const userListLoading = ref(false);
    const vendorUserForm = ref({ username: '', nickname: '', role: 'staff', vendor_id: '' });
    const vendorUserProvisioning = ref(false);
    const provisionedPin = ref('');
    const loginForm = ref({ username: '', password: '' });
    const authError = ref('');
    const isLoggingIn = ref(false);
    const showUserCPModal = ref(false);
    const userForm = ref({ nickname: '' });
    const passwordForm = ref({ oldPassword: '', newPassword: '', confirmPassword: '' });
    const userCPError = ref('');
    const userCPSaving = ref(false);
    const showPasswordOnboarding = ref(false);
    const onboardingPasswordForm = ref({ oldPassword: '', newPassword: '', confirmPassword: '' });
    const isSubmittingCategory = ref(false);
    const deferredPrompt = ref(null);
    const iosGuideDismissed = ref(false);
    const debugLogs = ref([]);
    const printSchoolId = ref('all');
    const editingProduct = ref(false);
    const editingSchool = ref(false);
    const productForm = ref({ code: '', name: '', unit: '', price: 0, category_id: '' });
    const categoryForm = ref({ name: '' });
    const editingCategoryId = ref('');
    const categoryDraftName = ref('');
    const categoryFilter = ref('');
    const showCategoryDeleteModal = ref(false);
    const categoryToDelete = ref(null);
    const categoryDeleteConfirmText = ref('');
    const schoolForm = ref({ id: '', name: '', bg_color: 'bg-sky-50', text_color: 'text-sky-800', border_color: 'border-sky-200', icon: 'fa-school', theme: 'bg-sky-50' });
    const stockForm = ref({ product_code: '', qty: 0 });
    const activeEditingCell = ref(null);
    const showSchoolDeleteModal = ref(false);
    const schoolToDelete = ref(null);
    const schoolDeleteConfirmText = ref('');
    const stagedOrders = ref([]);
    const quarantinedNewProducts = ref([]);
    const quarantinedNewSchools = ref([]);
    const showNewProductsModal = ref(false);
    const importSummary = ref(null);
    const excelFileInput = ref(null);
    const singleSchoolImportModal = ref(false);
    const singleSchoolImportTab = ref('file');
    const singleSchoolImportSchoolId = ref('');
    const singleSchoolImportText = ref('');
    const singleSchoolImportFileInput = ref(null);
    const catalogFileInput = ref(null);
    const showCatalogReviewModal = ref(false);
    const catalogReviewItems = ref([]);
    const catalogReviewCategories = ref([]);
    const catalogImportSummary = ref(null);
    const batchPopover = ref({ open: false, rowId: '', schoolId: '', position: {} });
    const batchForm = ref({ qtyChange: '', notePreset: 'Đợt bổ sung chiều', note: '' });
    let lastFetchWarningAt = 0;

    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    const isStandalone = computed(() =>
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true
    );
    const showIOSGuide = computed(() => isIOS && !isStandalone.value && !iosGuideDismissed.value);

    function generateShortcutFromName(name) {
      if (!name) return '';
      return String(name)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[đĐ]/g, 'd')
        .split(/[\s,.\-/]+/)
        .filter(Boolean)
        .map((word) => word.charAt(0))
        .join('')
        .replace(/[^a-z0-9]/g, '');
    }

    let syncing = false;
    let applyingRemote = false;
    let skipNextSync = false;
    const dirtyRows = new Set();

    const tabs = [
      { id: 'matrix', label: 'Nhập lưới', icon: 'fa-solid fa-table-cells' },
      { id: 'parser', label: 'Dán dữ liệu', icon: 'fa-solid fa-paste' },
      { id: 'catalog', label: 'Danh mục', icon: 'fa-solid fa-book' },
      { id: 'stock', label: 'Tồn kho', icon: 'fa-solid fa-boxes-stacked' },
      { id: 'analytics', label: 'Báo Cáo Thống Kê', icon: 'fa-solid fa-chart-pie' },
      { id: 'receipts', label: 'Biên bản in', icon: 'fa-solid fa-print' },
      { id: 'debug', label: 'Debug', icon: 'fa-solid fa-terminal' }
    ];
    const adminTabs = [
      { id: 'admin-vendors', label: 'Quản lý Vendor', icon: 'fa-solid fa-building-shield' },
      { id: 'admin-members', label: 'Quản lý Thành viên', icon: 'fa-solid fa-users-gear' },
      { id: 'admin-subscriptions', label: 'Quản lý Gói Dịch Vụ', icon: 'fa-solid fa-key' },
      { id: 'admin-revenue', label: 'Doanh Thu Nền Tảng', icon: 'fa-solid fa-chart-line' }
    ];

    const analyticsRange = ref('day');
    const schoolChartCanvas = ref(null);
    const categoryChartCanvas = ref(null);
    const trendChartCanvas = ref(null);
    const analyticsCharts = [];
    const analyticsMetrics = computed(() => {
      const schoolTotals = schools.value.map((school) => ({
        id: schoolKey(school),
        name: school.name || school.code,
        spend: 0,
        volume: 0
      }));
      const schoolById = new Map(schoolTotals.map((school) => [school.id, school]));
      const categoryTotals = new Map();
      let totalVolume = 0;
      let totalSpend = 0;
      let activeCells = 0;
      let fulfilledCells = 0;

      rows.value.forEach((row) => {
        const product = resolveProduct(row.productId || row.shortcut);
        if (!product) return;
        const category = categories.value.find((item) => String(item.id) === String(product.category_id));
        const categoryName = category?.name || 'Chưa phân nhóm';
        schools.value.forEach((school) => {
          const quantity = num(row.schoolQtys?.[schoolKey(school)]);
          if (quantity <= 0) return;
          const spend = quantity * num(product.price);
          const schoolTotal = schoolById.get(schoolKey(school));
          if (schoolTotal) {
            schoolTotal.volume += quantity;
            schoolTotal.spend += spend;
          }
          categoryTotals.set(categoryName, num(categoryTotals.get(categoryName)) + quantity);
          totalVolume += quantity;
          totalSpend += spend;
          activeCells += 1;
          fulfilledCells += quantity > 0 ? 1 : 0;
        });
      });

      return {
        totalSpend: Math.round(totalSpend),
        totalVolume: round3(totalVolume),
        fulfillment: activeCells ? Math.round((fulfilledCells / activeCells) * 100) : 0,
        schoolTotals: schoolTotals.sort((left, right) => right.spend - left.spend),
        categoryTotals: Array.from(categoryTotals, ([name, volume]) => ({ name, volume }))
          .sort((left, right) => right.volume - left.volume),
        trend: [{ label: deliveryDate.value, volume: round3(totalVolume) }]
      };
    });

    function renderAnalyticsCharts() {
      if (!window.Chart || currentTab.value !== 'analytics') return;
      analyticsCharts.splice(0).forEach((chart) => chart.destroy());
      const metrics = analyticsMetrics.value;
      const chartConfigs = [
        [schoolChartCanvas.value, {
          type: 'bar',
          data: {
            labels: metrics.schoolTotals.map((school) => school.name),
            datasets: [{ label: 'Chi phí', data: metrics.schoolTotals.map((school) => school.spend), backgroundColor: '#10b981' }]
          },
          options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
        }],
        [categoryChartCanvas.value, {
          type: 'doughnut',
          data: {
            labels: metrics.categoryTotals.map((category) => category.name),
            datasets: [{ data: metrics.categoryTotals.map((category) => category.volume), backgroundColor: ['#10b981', '#0ea5e9', '#8b5cf6', '#f59e0b', '#ef4444'] }]
          },
          options: { responsive: true, maintainAspectRatio: false }
        }],
        [trendChartCanvas.value, {
          type: 'line',
          data: {
            labels: metrics.trend.map((point) => point.label),
            datasets: [{ label: 'Khối lượng', data: metrics.trend.map((point) => point.volume), borderColor: '#0ea5e9', backgroundColor: 'rgba(14,165,233,.15)', fill: true, tension: .3 }]
          },
          options: { responsive: true, maintainAspectRatio: false }
        }]
      ];
      chartConfigs.forEach(([canvas, config]) => {
        if (canvas) analyticsCharts.push(new window.Chart(canvas, config));
      });
    }

    function logError(context, error) {
      const message = error?.message || String(error);
      debugLogs.value.push({
        id: uid(),
        timestamp: nowText(),
        context,
        message,
        stack: error?.stack || ''
      });
      if (debugLogs.value.length > 200) debugLogs.value.shift();
    }

    function addToast(message, type = 'info') {
      const id = uid();
      notifications.value.push({ id, message, type });
      setTimeout(() => {
        notifications.value = notifications.value.filter((notification) => notification.id !== id);
      }, 4000);
    }

    const triggerNotification = addToast;

    function dismissStatusBanner() {
      statusBanner.value = '';
    }

    function dismissNotification(notificationId) {
      notifications.value = notifications.value.filter((notification) => notification.id !== notificationId);
    }

    async function copyTempPin(user) {
      if (!user?.temp_pin) return;
      try {
        await navigator.clipboard.writeText(user.temp_pin);
        addToast(`Đã sao chép mã PIN tạm của ${user.username} vào bộ nhớ tạm!`, 'success');
      } catch (error) {
        logError('copyTempPin', error);
        addToast('Không thể sao chép mã PIN vào bộ nhớ tạm.', 'error');
      }
    }

    function handleAuthCallback() {
      const tokenParam = new URLSearchParams(window.location.search).get('auth_token');
      if (!tokenParam || tokenParam === 'null') return false;
      authToken.value = tokenParam;
      localStorage.setItem('auth_token', tokenParam);
      window.history.replaceState({}, document.title, window.location.pathname);
      return true;
    }

    function markRowDirty(row) {
      if (!row?.id) return;
      row.isDirty = true;
      dirtyRows.add(row.id);
    }

    function clearRowDirty(row) {
      if (!row?.id) return;
      row.isDirty = false;
      dirtyRows.delete(row.id);
    }

    function lockCell(row, field) {
      activeEditingCell.value = { rowId: row?.id || null, field };
    }

    function setActiveEditingCell(rowId, field) {
      activeEditingCell.value = { rowId, field };
    }

    function clearActiveEditingCell() {
      activeEditingCell.value = null;
    }

    function unlockCell(row, field) {
      if (activeEditingCell.value?.rowId === row?.id && activeEditingCell.value?.field === field) {
        activeEditingCell.value = null;
      }
    }

    function setStatus(mode, origin, banner = '') {
      syncStatus.value = mode;
      dataOrigin.value = origin;
      statusBanner.value = banner;
      if (origin === 'API' && mode === 'Sẵn sàng') lastSyncAt.value = nowText();
    }

    const lastSyncLabel = computed(() => lastSyncAt.value || 'chưa có');
    const pendingMutationCount = computed(() =>
      rows.value.filter((row) => row.isDirty || dirtyRows.has(row.id)).length +
      products.value.filter((product) => product.isDirty).length +
      categories.value.filter((category) => category.isDirty).length
    );

    function themeStyle(item) {
      const theme = themeMap[item?.bg_color] || themeMap['bg-sky-50'];
      const palette = {
        'bg-sky-50': ['#f0f9ff', '#075985', '#bae6fd'],
        'bg-emerald-50': ['#ecfdf5', '#065f46', '#a7f3d0'],
        'bg-amber-50': ['#fffbeb', '#92400e', '#fde68a'],
        'bg-rose-50': ['#fff1f2', '#9f1239', '#fecdd3'],
        'bg-violet-50': ['#f5f3ff', '#6d28d9', '#ddd6fe'],
        'bg-cyan-50': ['#ecfeff', '#155e75', '#a5f3fc']
      };
      const [background, color, borderColor] = palette[theme.bg_color] || palette['bg-sky-50'];
      return { background, color, borderColor };
    }

    function ensureRowSchools(row) {
      if (row.isDirty === undefined) row.isDirty = false;
      if (row.searchQuery === undefined) row.searchQuery = row.shortcut || '';
      if (!row.schoolQtys) row.schoolQtys = {};
      if (!row.schoolBatches) row.schoolBatches = {};
      if (!row.schoolOrderIds) row.schoolOrderIds = {};
      schools.value.forEach((school) => {
        const key = schoolKey(school);
        if (row.schoolQtys[key] === undefined) row.schoolQtys[key] = 0;
        if (!Array.isArray(row.schoolBatches[key])) row.schoolBatches[key] = [];
        if (row.schoolOrderIds[key] === undefined) row.schoolOrderIds[key] = '';
      });
      Object.keys(row.schoolQtys).forEach((key) => {
        if (!schools.value.some((school) => schoolKey(school) === String(key))) delete row.schoolQtys[key];
        if (!schools.value.some((school) => schoolKey(school) === String(key))) delete row.schoolBatches[key];
        if (!schools.value.some((school) => schoolKey(school) === String(key))) delete row.schoolOrderIds[key];
      });
    }

    function ensureMasterDirtyFlags() {
      products.value.forEach((product) => {
        if (product.isDirty === undefined) product.isDirty = false;
      });
      categories.value.forEach((category) => {
        if (category.isDirty === undefined) category.isDirty = false;
      });
    }

    function recalcRow(row) {
      ensureRowSchools(row);
      const product = resolveProduct(row.productId) || resolveProduct(row.shortcut);
      if (product) {
        row.productId = productKey(product);
        row.shortcut = product.code;
        row.productName = product.name;
        row.unit = product.unit;
        row.price = num(product.price);
      }
      row.totalQty = round3(schools.value.reduce((sum, school) => sum + num(row.schoolQtys[schoolKey(school)]), 0));
      row.subTotal = Math.round(row.totalQty * num(row.price));
    }

    function findSuggestions(query) {
      const q = norm(query);
      if (!q) return [];
      return products.value
        .filter((product) => norm(product.code).includes(q) || norm(product.name).includes(q))
        .sort((a, b) => {
          const aw = norm(a.code).startsWith(q) ? 0 : 1;
          const bw = norm(b.code).startsWith(q) ? 0 : 1;
          return aw - bw || norm(a.code).localeCompare(norm(b.code));
        })
        .slice(0, 5);
    }

    function openSuggestions(row, event) {
      const target = event?.currentTarget;
      if (target) {
        const rect = target.getBoundingClientRect();
        row.suggestionPosition = {
          top: `${rect.bottom + window.scrollY}px`,
          left: `${rect.left + window.scrollX}px`
        };
      }
      row.suggestions = findSuggestions(row.searchQuery);
      row.suggestIndex = 0;
      row.showDropdown = true;
      row.showSuggestions = true;
    }

    function suggestionStyle(row) {
      return row.suggestionPosition || {};
    }

    function closeSuggestions(row) {
      setTimeout(() => {
        row.searchQuery = row.shortcut || '';
        row.showDropdown = false;
        row.showSuggestions = false;
      }, 120);
    }

    function pickProduct(row, product) {
      row.shortcut = product.code;
      row.searchQuery = product.code;
      row.productId = productKey(product);
      row.productName = product.name;
      row.unit = product.unit;
      row.price = num(product.price);
      row.suggestions = [];
      row.showDropdown = false;
      row.showSuggestions = false;
      recalcRow(row);
      markRowDirty(row);
      scheduleSync();
    }

    function onShortcutInput(row) {
      row.searchQuery = String(row.searchQuery || '').trim().toLowerCase();
      row.suggestions = findSuggestions(row.searchQuery);
      row.suggestIndex = 0;
      row.showDropdown = Boolean(row.searchQuery && row.suggestions.length);
      row.showSuggestions = row.showDropdown;
    }

    function onShortcutKeydown(event, row) {
      if (!row.suggestions.length || !row.showDropdown) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        row.suggestIndex = (row.suggestIndex + 1) % row.suggestions.length;
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        row.suggestIndex = (row.suggestIndex - 1 + row.suggestions.length) % row.suggestions.length;
      } else if (event.key === 'Enter') {
        event.preventDefault();
        pickProduct(row, row.suggestions[row.suggestIndex] || row.suggestions[0]);
      } else if (event.key === 'Escape') {
        row.searchQuery = row.shortcut || '';
        row.showDropdown = false;
        row.showSuggestions = false;
      }
    }

    function openBatchPopover(row, school, event) {
      const schoolId = schoolKey(school);
      ensureRowSchools(row);
      ensureDefaultBatch(row, schoolId);
      const rect = event.currentTarget.getBoundingClientRect();
      batchPopover.value = {
        open: true,
        rowId: row.id,
        schoolId,
        position: {
          top: `${rect.bottom + window.scrollY + 4}px`,
          left: `${Math.min(rect.left + window.scrollX, Math.max(16, window.scrollX + window.innerWidth - 280))}px`
        }
      };
      batchForm.value = { qtyChange: '', notePreset: 'Đợt bổ sung chiều', note: '' };
    }

    function closeBatchPopover() {
      batchPopover.value.open = false;
    }

    function activeBatchRow() {
      return rows.value.find((row) => row.id === batchPopover.value.rowId);
    }

    function activeBatchList() {
      const row = activeBatchRow();
      return row?.schoolBatches?.[batchPopover.value.schoolId] || [];
    }

    function applyBatchAdjustment() {
      const row = activeBatchRow();
      const amount = num(batchForm.value.qtyChange);
      if (!row || !amount) return;
      const note = batchForm.value.notePreset === 'Khác'
        ? batchForm.value.note.trim()
        : batchForm.value.notePreset;
      if (!note) return;
      const schoolId = batchPopover.value.schoolId;
      ensureRowSchools(row);
      ensureDefaultBatch(row, schoolId);
      row.schoolBatches[schoolId].push({
        id: uid(),
        qty_change: round3(amount),
        note
      });
      row.schoolQtys[schoolId] = batchTotal(row.schoolBatches[schoolId]);
      recalcRow(row);
      markRowDirty(row);
      scheduleSync();
      batchForm.value = { qtyChange: '', notePreset: 'Đợt bổ sung chiều', note: '' };
    }

    function deleteBatch(batchId) {
      const row = activeBatchRow();
      if (!row) return;
      const schoolId = batchPopover.value.schoolId;
      row.schoolBatches[schoolId] = activeBatchList().filter((batch) => batch.id !== batchId);
      row.schoolQtys[schoolId] = batchTotal(row.schoolBatches[schoolId]);
      recalcRow(row);
      markRowDirty(row);
      scheduleSync();
    }

    function addRow() {
      const row = emptyRow();
      schools.value.forEach((school) => {
        const schoolId = schoolKey(school);
        row.schoolQtys[schoolId] = 0;
        row.schoolBatches[schoolId] = [];
      });
      rows.value.push(row);
      scheduleSync();
    }

    function removeRow(id) {
      rows.value = rows.value.filter((row) => row.id !== id);
      scheduleSync();
    }

    function clearRows() {
      rows.value = [emptyRow()];
      rows.value.forEach(recalcRow);
      scheduleSync();
    }

    function batchTotal(batches) {
      return round3((batches || []).reduce((sum, batch) => sum + num(batch.qty_change), 0));
    }

    function ensureSchoolOrderId(row, schoolId) {
      if (!row.schoolOrderIds[schoolId]) row.schoolOrderIds[schoolId] = uid();
      return row.schoolOrderIds[schoolId];
    }

    function ensureDefaultBatch(row, schoolId) {
      const batches = row.schoolBatches[schoolId];
      if (!batches.length && num(row.schoolQtys[schoolId])) {
        row.schoolBatches[schoolId] = [{
          id: uid(),
          qty_change: round3(row.schoolQtys[schoolId]),
          note: 'Đợt sáng mặc định'
        }];
      }
      return row.schoolBatches[schoolId];
    }

    function rowToOrderRecords(row) {
      const product = resolveProduct(row.productId || row.shortcut);
      if (!product) return [];
      return schools.value.flatMap((school) => {
        const schoolId = schoolKey(school);
        const qtyValue = num(row.schoolQtys?.[schoolId]);
        return qtyValue !== 0 ? [{
          delivery_date: deliveryDate.value,
          product_id: productKey(product),
          school_id: schoolId,
          qty: round3(qtyValue),
          batches: row.schoolBatches?.[schoolId] || []
        }] : [];
      });
    }

    function ordersToRows(orderRecords) {
      const map = {};
      orderRecords.forEach((order) => {
        const productId = String(order.product_id || order.product_code || '');
        if (!productId) return;
        if (!map[productId]) {
          const product = resolveProduct(productId);
          map[productId] = emptyRow();
          map[productId].productId = productKey(product || { id: productId });
          map[productId].shortcut = product?.code || order.product_code || '';
          if (product) {
            map[productId].productName = product.name;
            map[productId].unit = product.unit;
            map[productId].price = num(product.price);
          }
          schools.value.forEach((school) => { map[productId].schoolQtys[schoolKey(school)] = 0; });
        }
        const schoolId = String(order.school_id);
        map[productId].schoolQtys[schoolId] = num(order.qty);
        map[productId].schoolOrderIds[schoolId] = String(order.id || '');
        map[productId].schoolBatches[schoolId] = (order.batches || []).map((batch) => ({
          id: batch.id || uid(),
          daily_order_id: batch.daily_order_id || order.id || null,
          qty_change: round3(batch.qty_change),
          note: batch.note || ''
        }));
        if (!map[productId].schoolBatches[schoolId].length && num(order.qty)) {
          map[productId].schoolBatches[schoolId] = [{
            id: uid(),
            qty_change: round3(order.qty),
            note: 'Đợt sáng mặc định'
          }];
        }
      });
      return Object.values(map).map((row) => {
        recalcRow(row);
        return row;
      });
    }

    function groupOrdersBySchool() {
      const buckets = {};
      schools.value.forEach((school) => { buckets[schoolKey(school)] = {}; });
      rows.value.forEach((row) => {
        const product = resolveProduct(row.productId || row.shortcut);
        if (!product) return;
        schools.value.forEach((school) => {
          const schoolId = schoolKey(school);
          const qtyValue = num(row.schoolQtys?.[schoolId]);
          if (!qtyValue) return;
          if (!buckets[schoolId][product.code]) {
            buckets[schoolId][product.code] = {
              code: product.code,
              name: product.name,
              unit: product.unit,
              price: num(product.price),
              qty: 0,
              amount: 0
            };
          }
          buckets[schoolId][product.code].qty += qtyValue;
          buckets[schoolId][product.code].amount = Math.round(buckets[schoolId][product.code].qty * num(product.price));
        });
      });
      return buckets;
    }

    const totalBySchool = computed(() => {
      const totals = {};
      schools.value.forEach((school) => { totals[schoolKey(school)] = 0; });
      rows.value.forEach((row) => {
        schools.value.forEach((school) => {
          totals[schoolKey(school)] += num(row.schoolQtys?.[schoolKey(school)]) * num(row.price);
        });
      });
      return totals;
    });

    const totalSchoolMoney = computed(() => Object.values(totalBySchool.value).reduce((sum, value) => sum + num(value), 0));

    const summaryList = computed(() => {
      const map = {};
      rows.value.forEach((row) => {
        const product = resolveProduct(row.productId || row.shortcut);
        if (!product) return;
        if (!map[product.code]) {
          map[product.code] = {
            id: productKey(product),
            code: product.code,
            name: product.name,
            unit: product.unit,
            price: num(product.price),
            demandQty: 0
          };
        }
        map[product.code].demandQty += row.totalQty;
      });
      return Object.values(map)
        .map((item) => {
          const stockQty = num(stockMap.value[item.id]);
          const realBuy = Math.max(0, round3(item.demandQty - stockQty));
          return { ...item, stockQty, realBuy, subTotal: Math.round(realBuy * item.price) };
        })
        .sort((a, b) => norm(a.code).localeCompare(norm(b.code)));
    });

    const totalRealCost = computed(() => summaryList.value.reduce((sum, item) => sum + num(item.subTotal), 0));
    const totalSavedMoney = computed(() => summaryList.value.reduce((sum, item) => sum + Math.round(Math.min(item.demandQty, item.stockQty) * item.price), 0));

    const filteredProducts = computed(() => {
      const q = norm(productFilter.value);
      return products.value.filter((item) => {
          const matchesText = !q || norm(item.code).includes(q) || norm(item.name).includes(q);
          const matchesCategory = !productCategoryFilter.value || String(item.category_id || '') === String(productCategoryFilter.value);
          return matchesText && matchesCategory;
        })
        .slice()
        .sort((a, b) => {
          const categoryA = categories.value.find((category) => category.id === a.category_id)?.name || '';
          const categoryB = categories.value.find((category) => category.id === b.category_id)?.name || '';
          return norm(categoryA).localeCompare(norm(categoryB)) || norm(a.code).localeCompare(norm(b.code));
        });
    });

    const filteredCategories = computed(() => {
      const q = norm(categoryFilter.value);
      return !q ? categories.value : categories.value.filter((category) => norm(category.name).includes(q));
    });

    const categoryProductCount = (categoryId) => products.value.filter((product) => String(product.category_id || '') === String(categoryId)).length;
    const pageCount = (items) => Math.max(1, Math.ceil(items.length / pageSize));
    const pageItems = (items, page) => items.slice((page - 1) * pageSize, page * pageSize);
    const paginatedRows = computed(() => pageItems(rows.value, matrixPage.value));
    const paginatedProducts = computed(() => pageItems(filteredProducts.value, catalogPage.value));
    const paginatedStockProducts = computed(() => pageItems(filteredStockProducts.value, stockPage.value));
    const matrixPageCount = computed(() => pageCount(rows.value));
    const catalogPageCount = computed(() => pageCount(filteredProducts.value));
    const stockPageCount = computed(() => pageCount(filteredStockProducts.value));
    const paginationLabel = (items, page) => `Trang ${page} / ${pageCount(items)} · Tổng: ${items.length}`;
    function previousPage(pageName) {
      const pageRef = { matrix: matrixPage, stock: stockPage, catalog: catalogPage }[pageName];
      pageRef.value = Math.max(1, pageRef.value - 1);
    }
    function nextPage(pageName, items) {
      const pageRef = { matrix: matrixPage, stock: stockPage, catalog: catalogPage }[pageName];
      pageRef.value = Math.min(pageCount(items), pageRef.value + 1);
    }

    const categoryName = (categoryId) => categories.value.find((category) => String(category.id) === String(categoryId))?.name || 'Chưa phân nhóm';

    const catalogImportInvalidItems = computed(() => {
      const counts = new Map();
      catalogReviewItems.value.forEach((item) => {
        const code = norm(item.code);
        counts.set(code, (counts.get(code) || 0) + 1);
      });
      return catalogReviewItems.value.filter((item) => {
        const code = norm(item.code);
        const formatInvalid = !/^[a-z][a-z0-9_-]*$/i.test(code);
        const duplicateStaged = Boolean(code) && counts.get(code) > 1;
        const existing = products.value.find((product) => norm(product.code) === code);
        const existingConflict = Boolean(existing && String(existing.id || '') !== String(item.existingProductId || ''));
        return formatInvalid || duplicateStaged || existingConflict;
      });
    });
    const catalogImportReady = computed(() => catalogReviewItems.value.length > 0 && catalogImportInvalidItems.value.length === 0);

    const filteredSchools = computed(() => {
      const q = norm(schoolFilter.value);
      return !q ? schools.value : schools.value.filter((item) => norm(item.id).includes(q) || norm(item.code).includes(q) || norm(item.name).includes(q));
    });

    const filteredStockProducts = computed(() => {
      const q = norm(stockFilter.value);
      return !q ? products.value : products.value.filter((item) => norm(item.code).includes(q) || norm(item.name).includes(q));
    });

    watch([productFilter, productCategoryFilter], () => { catalogPage.value = 1; });
    watch(stockFilter, () => { stockPage.value = 1; });

    const receipts = computed(() => {
      const buckets = groupOrdersBySchool();
      return schools.value.map((school) => {
        const schoolId = schoolKey(school);
        const items = Object.values(buckets[schoolId]).filter((item) => item.qty > 0).sort((a, b) => norm(a.code).localeCompare(norm(b.code)));
        return {
          id: schoolId,
          name: school.name,
          theme: school,
          items,
          totalQty: items.reduce((sum, item) => sum + item.qty, 0),
          totalAmount: items.reduce((sum, item) => sum + item.amount, 0)
        };
      });
    });

    function persistLocal() {
      if (!activeVendorId.value) return;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          schools: schools.value,
          products: products.value,
          categories: categories.value,
          stockMap: stockMap.value,
          rows: rows.value,
          deliveryDate: deliveryDate.value
        }));
      } catch (error) {
        logError('persistLocal', error);
      }
    }

    function clearTransientState() {
      notifications.value = [];
      statusBanner.value = '';
      debugLogs.value = [];
      currentTab.value = 'matrix';
      productFilter.value = '';
      productCategoryFilter.value = '';
      schoolFilter.value = '';
      stockFilter.value = '';
      matrixPage.value = 1;
      stockPage.value = 1;
      catalogPage.value = 1;
      parserText.value = '';
      parserPreview.value = [];
      activeEditingCell.value = null;
      batchPopover.value = { open: false, rowId: '', schoolId: '', position: {} };
      batchForm.value = { qtyChange: '', notePreset: 'Đợt bổ sung chiều', note: '' };
      showUserCPModal.value = false;
      showPasswordOnboarding.value = false;
      showNewProductsModal.value = false;
      singleSchoolImportModal.value = false;
      showCatalogReviewModal.value = false;
      showSchoolDeleteModal.value = false;
      showCategoryDeleteModal.value = false;
      userCPError.value = '';
      authError.value = '';
      users.value = [];
      vendors.value = [];
      selectedVendorId.value = '';
      provisionedPin.value = '';
      vendorForm.value = { code: '', name: '', status: 'active' };
      vendorUserForm.value = { username: '', nickname: '', role: 'staff', vendor_id: '' };
      importSummary.value = null;
      catalogImportSummary.value = null;
      quarantinedNewProducts.value = [];
      quarantinedNewSchools.value = [];
      stagedOrders.value = [];
    }

    function resetInMemoryDatabase() {
      rows.value = [emptyRow()];
      schools.value = [];
      products.value = [];
      categories.value = [];
      stockMap.value = {};
      deliveryDate.value = today;
      dirtyRows.clear();
      rows.value.forEach((row) => {
        schools.value.forEach((school) => {
          const schoolId = schoolKey(school);
          row.schoolQtys[schoolId] = 0;
          row.schoolBatches[schoolId] = [];
        });
      });
    }

    function clearLocalDatabase() {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(ACTIVE_VENDOR_STORAGE_KEY);
      resetInMemoryDatabase();
      clearTransientState();
    }

    function setActiveVendor(user) {
      const nextVendorId = user?.vendor_id
        ? String(user.vendor_id)
        : user?.role === 'admin'
          ? `admin:${String(user.id)}`
          : '';
      if (activeVendorId.value && nextVendorId && activeVendorId.value !== nextVendorId) {
        clearLocalDatabase();
      }
      activeVendorId.value = nextVendorId;
      if (nextVendorId) localStorage.setItem(ACTIVE_VENDOR_STORAGE_KEY, nextVendorId);
    }

    function hydrateLocal() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
          rows.value = [emptyRow()];
          schools.value = [];
          products.value = [];
          stockMap.value = {};
          rows.value.forEach((row) => {
            schools.value.forEach((school) => {
              const schoolId = schoolKey(school);
              row.schoolQtys[schoolId] = 0;
              row.schoolBatches[schoolId] = [];
            });
          });
          return;
        }
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.schools)) schools.value = parsed.schools;
        if (Array.isArray(parsed.products)) products.value = parsed.products;
        if (Array.isArray(parsed.categories)) categories.value = parsed.categories;
        if (parsed.stockMap && typeof parsed.stockMap === 'object') stockMap.value = normalizeStockMap(parsed.stockMap);
        if (Array.isArray(parsed.rows) && parsed.rows.length) rows.value = parsed.rows;
        if (parsed.deliveryDate) deliveryDate.value = parsed.deliveryDate;
        rows.value.forEach((row) => {
          ensureRowSchools(row);
          recalcRow(row);
        });
      } catch (error) {
        logError('hydrateLocal', error);
      }
    }

    async function apiJson(path, options = {}) {
      const token = authToken.value;
      let response;
      try {
        response = await fetch(`${API_BASE}${path}`, {
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...options.headers
          },
          ...options
        });
      } catch (error) {
        if (error instanceof TypeError && error.message === 'Failed to fetch' && Date.now() - lastFetchWarningAt > 5000) {
          lastFetchWarningAt = Date.now();
          addToast('Hệ thống đang khởi động lại nguồn cấp dữ liệu đám mây (Render Free Tier), vui lòng đợi trong 30 giây và thử lại!', 'warn');
        }
        throw error;
      }
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      if (!response.ok) {
        const detail = typeof data === 'object' && data?.detail ? data.detail : text || `HTTP ${response.status}`;
        const error = new Error(detail);
        error.status = response.status;
        throw error;
      }
      return data;
    }

    async function loginWithCredentials() {
      if (isLoggingIn.value) return;
      authError.value = '';
      isLoggingIn.value = true;
      try {
        const response = await apiJson('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify(loginForm.value)
        });
        authToken.value = response.access_token;
        localStorage.setItem('auth_token', response.access_token);
        loginForm.value.password = '';
        await loadAuthUser();
        if (!authToken.value) {
          throw new Error('Phiên đăng nhập không hợp lệ.');
        }
        if (!isAdmin.value) {
          loadInitialState();
          await initializeAuthenticatedState();
        }
        mustChangePassword.value = Boolean(response.must_change_password || currentUser.value?.must_change_password);
        showPasswordOnboarding.value = mustChangePassword.value;
        addToast(`Xin chào ${response.user.username}`, 'success');
      } catch (error) {
        authError.value = error.message || 'Đăng nhập thất bại.';
      } finally {
        isLoggingIn.value = false;
      }
    }

    async function loginWithGoogle() {
      if (isLoggingIn.value) return;
      authError.value = '';
      isLoggingIn.value = true;
      try {
        const response = await apiJson('/api/auth/google/url');
        if (!response?.url) throw new Error('Backend không trả về URL Google OAuth.');
        window.location.href = response.url;
      } catch (error) {
        authError.value = error.message || 'Không thể khởi động Google OAuth.';
        isLoggingIn.value = false;
      }
    }

    async function loadAuthUser() {
      if (!authToken.value) return;
      try {
        currentUser.value = await apiJson('/api/auth/me');
        setActiveVendor(currentUser.value);
        mustChangePassword.value = Boolean(currentUser.value?.must_change_password);
        showPasswordOnboarding.value = mustChangePassword.value;
        if (['admin', 'owner', 'manager'].includes(currentUser.value.role)) {
          if (currentUser.value.role === 'admin') {
            currentTab.value = 'admin-vendors';
            vendors.value = await apiJson('/api/vendors');
            selectedVendorId.value = vendors.value[0]?.id || '';
          } else {
            selectedVendorId.value = currentUser.value.vendor_id || '';
          }
          userListLoading.value = true;
          users.value = await apiJson('/api/auth/users');
          if (currentUser.value.role === 'admin') await loadAdminSubscriptionData();
        }
        return true;
      } catch (error) {
        logError('loadAuthUser', error);
        if (error?.status === 401) logout();
        return false;
      } finally {
        userListLoading.value = false;
      }
    }

    async function loadAdminSubscriptionData() {
      try {
        const [codes, metrics] = await Promise.all([
          apiJson('/api/admin/subscription-codes'),
          apiJson('/api/admin/subscription-metrics')
        ]);
        subscriptionCodes.value = Array.isArray(codes) ? codes : [];
        subscriptionMetrics.value = metrics || subscriptionMetrics.value;
      } catch (error) {
        logError('loadAdminSubscriptionData', error);
      }
    }

    async function generateSubscriptionCode() {
      if (subscriptionCodeGenerating.value) return;
      subscriptionCodeGenerating.value = true;
      try {
        const created = await apiJson('/api/admin/subscription-codes', {
          method: 'POST',
          body: JSON.stringify(subscriptionCodeForm.value)
        });
        subscriptionCodes.value = [created, ...subscriptionCodes.value];
        subscriptionCodeForm.value = { duration_months: 1, price_allocated: 0 };
        subscriptionMetrics.value.generated_codes += 1;
        addToast('Đã tạo mã gia hạn mới.', 'success');
      } catch (error) {
        addToast(error.message || 'Không thể tạo mã gia hạn.', 'error');
      } finally {
        subscriptionCodeGenerating.value = false;
      }
    }

    async function redeemSubscriptionCode() {
      if (redeemingCode.value || !renewalCode.value.trim()) return;
      redeemingCode.value = true;
      userCPError.value = '';
      try {
        currentUser.value = await apiJson('/api/auth/redeem-code', {
          method: 'POST',
          body: JSON.stringify({ code: renewalCode.value })
        });
        renewalCode.value = '';
        addToast('Đã gia hạn gói dịch vụ thành công.', 'success');
      } catch (error) {
        userCPError.value = error.message || 'Mã gia hạn không hợp lệ.';
      } finally {
        redeemingCode.value = false;
      }
    }

    function openUserCPModal() {
      userForm.value = { nickname: currentUser.value?.nickname || '' };
      passwordForm.value = { oldPassword: '', newPassword: '', confirmPassword: '' };
      userCPError.value = '';
      showUserCPModal.value = true;
    }

    function closeUserCPModal() {
      showUserCPModal.value = false;
      userCPError.value = '';
      passwordForm.value = { oldPassword: '', newPassword: '', confirmPassword: '' };
    }

    async function saveUserProfile() {
      if (userCPSaving.value) return;
      userCPError.value = '';
      userCPSaving.value = true;
      try {
        currentUser.value = await apiJson('/api/auth/profile', {
          method: 'PUT',
          body: JSON.stringify({ nickname: userForm.value.nickname.trim() || null })
        });
        addToast('Đã cập nhật thông tin cá nhân.', 'success');
      } catch (error) {
        userCPError.value = error.message || 'Không thể cập nhật thông tin cá nhân.';
      } finally {
        userCPSaving.value = false;
      }
    }

    async function provisionVendorUser() {
      if (vendorUserProvisioning.value) return;
      vendorUserProvisioning.value = true;
      userCPError.value = '';
      provisionedPin.value = '';
      try {
        const vendorId = isAdmin.value ? selectedVendorId.value : currentUser.value?.vendor_id;
        if (!vendorId) throw new Error('Hãy chọn vendor trước khi tạo tài khoản.');
        const response = await apiJson('/api/auth/users', {
          method: 'POST',
          body: JSON.stringify({ ...vendorUserForm.value, vendor_id: vendorId })
        });
        provisionedPin.value = response.temporary_pin || '';
        vendorUserForm.value = { username: '', nickname: '', role: 'staff', vendor_id: vendorId };
        users.value = await apiJson('/api/auth/users');
        addToast('Đã tạo tài khoản vendor với PIN tạm thời.', 'success');
      } catch (error) {
        userCPError.value = error.message || 'Không thể tạo tài khoản vendor.';
      } finally {
        vendorUserProvisioning.value = false;
      }
    }

    async function createVendor() {
      if (vendorSaving.value) return;
      vendorSaving.value = true;
      userCPError.value = '';
      try {
        const created = await apiJson('/api/vendors', {
          method: 'POST',
          body: JSON.stringify(vendorForm.value)
        });
        vendors.value = [...vendors.value, created].sort((left, right) => left.name.localeCompare(right.name));
        selectedVendorId.value = created.id;
        vendorForm.value = { code: '', name: '', status: 'active' };
        users.value = await apiJson('/api/auth/users');
        addToast('Đã tạo vendor mới.', 'success');
      } catch (error) {
        userCPError.value = error.message || 'Không thể tạo vendor.';
      } finally {
        vendorSaving.value = false;
      }
    }

    function editVendor(vendor) {
      editingVendorId.value = vendor.id;
      vendorForm.value = { code: vendor.code || '', name: vendor.name || '', status: vendor.status || 'active' };
    }

    async function saveVendor() {
      if (editingVendorId.value) {
        if (vendorSaving.value) return;
        vendorSaving.value = true;
        userCPError.value = '';
        try {
          const updated = await apiJson(`/api/vendors/${encodeURIComponent(editingVendorId.value)}`, {
            method: 'PUT',
            body: JSON.stringify(vendorForm.value)
          });
          const index = vendors.value.findIndex((vendor) => vendor.id === updated.id);
          if (index >= 0) vendors.value[index] = updated;
          editingVendorId.value = '';
          vendorForm.value = { code: '', name: '', status: 'active' };
          addToast('Đã cập nhật vendor.', 'success');
        } catch (error) {
          userCPError.value = error.message || 'Không thể cập nhật vendor.';
        } finally {
          vendorSaving.value = false;
        }
        return;
      }
      await createVendor();
    }

    async function selectVendor(vendorId) {
      selectedVendorId.value = vendorId;
    }

    async function saveUserAssignment(user) {
      if (!isAdmin.value || !user?.vendor_id) return;
      try {
        const updated = await apiJson(`/api/auth/users/${encodeURIComponent(user.id)}`, {
          method: 'PUT',
          body: JSON.stringify({
            vendor_id: user.vendor_id,
            role: user.role,
            status: user.status
          })
        });
        const index = users.value.findIndex((item) => item.id === updated.id);
        if (index >= 0) users.value[index] = updated;
        addToast(`Đã gán ${updated.username} vào vendor.`, 'success');
      } catch (error) {
        userCPError.value = error.message || 'Không thể cập nhật phân quyền vendor.';
      }
    }

    async function changePassword() {
      if (userCPSaving.value) return;
      userCPError.value = '';
      if (passwordForm.value.newPassword !== passwordForm.value.confirmPassword) {
        userCPError.value = 'Mật khẩu mới và phần xác nhận không khớp.';
        return;
      }
      userCPSaving.value = true;
      try {
        const response = await apiJson('/api/auth/change-password', {
          method: 'POST',
          body: JSON.stringify({
            old_password: passwordForm.value.oldPassword,
            new_password: passwordForm.value.newPassword
          })
        });
        if (response.access_token) {
          authToken.value = response.access_token;
          localStorage.setItem('auth_token', response.access_token);
        }
        if (response.user) currentUser.value = response.user;
        passwordForm.value = { oldPassword: '', newPassword: '', confirmPassword: '' };
        mustChangePassword.value = false;
        addToast('Đã đổi mật khẩu thành công.', 'success');
      } catch (error) {
        userCPError.value = error.message || 'Không thể đổi mật khẩu.';
      } finally {
        userCPSaving.value = false;
      }
    }

    async function submitPasswordOnboarding() {
      if (userCPSaving.value) return;
      userCPError.value = '';
      const form = onboardingPasswordForm.value;
      if (form.newPassword.length < 8) {
        userCPError.value = 'Mật khẩu mới phải có ít nhất 8 ký tự.';
        return;
      }
      if (form.newPassword !== form.confirmPassword) {
        userCPError.value = 'Mật khẩu mới và phần xác nhận không khớp.';
        return;
      }
      userCPSaving.value = true;
      try {
        const response = await apiJson('/api/auth/change-password', {
          method: 'POST',
          body: JSON.stringify({
            old_password: form.oldPassword,
            new_password: form.newPassword
          })
        });
        if (response.access_token) {
          authToken.value = response.access_token;
          localStorage.setItem('auth_token', response.access_token);
        }
        if (response.user) currentUser.value = response.user;
        onboardingPasswordForm.value = { oldPassword: '', newPassword: '', confirmPassword: '' };
        mustChangePassword.value = false;
        showPasswordOnboarding.value = false;
        addToast('Đã thiết lập mật khẩu bảo mật.', 'success');
      } catch (error) {
        userCPError.value = error.message || 'Không thể thiết lập mật khẩu.';
      } finally {
        userCPSaving.value = false;
      }
    }

    function logout() {
      clearLocalDatabase();
      authToken.value = '';
      currentUser.value = null;
      users.value = [];
      mustChangePassword.value = false;
      showPasswordOnboarding.value = false;
      localStorage.removeItem('auth_token');
      authError.value = '';
    }

    async function fetchSchools() {
      return apiJson('/api/schools');
    }

    async function fetchProducts() {
      return apiJson('/api/products');
    }

    async function fetchCategories() {
      return apiJson('/api/categories');
    }

    function applyCategoryRows(categoryRows) {
      if (!Array.isArray(categoryRows)) return;
      categories.value = categoryRows.map((category) => ({
        ...category,
        isDirty: false
      }));
    }

    async function fetchStock() {
      return apiJson('/api/stock');
    }

    async function fetchOrders(date) {
      return apiJson(`/api/orders?date=${encodeURIComponent(date)}`);
    }

    async function saveSchoolApi(payload) {
      return apiJson('/api/schools', { method: 'POST', body: JSON.stringify(payload) });
    }

    async function deleteSchoolApi(id) {
      return apiJson(`/api/schools/${encodeURIComponent(id)}`, { method: 'DELETE' });
    }

    async function saveProductApi(payload) {
      return apiJson('/api/products', { method: 'POST', body: JSON.stringify(payload) });
    }

    async function saveProductsBulkApi(payload) {
      return apiJson('/api/products/bulk', { method: 'POST', body: JSON.stringify(payload) });
    }

    async function saveCategoryApi(payload) {
      return apiJson('/api/categories', { method: 'POST', body: JSON.stringify(payload) });
    }

    async function updateCategoryApi(id, payload) {
      return apiJson(`/api/categories/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(payload) });
    }

    async function deleteCategoryApi(id) {
      return apiJson(`/api/categories/${encodeURIComponent(id)}`, { method: 'DELETE' });
    }

    async function deleteProductApi(code) {
      return apiJson(`/api/products/${encodeURIComponent(code)}`, { method: 'DELETE' });
    }

    async function saveStockApi(payload) {
      return apiJson('/api/stock/upsert', { method: 'POST', body: JSON.stringify(payload) });
    }

    async function upsertOrderApi(payload) {
      return apiJson('/api/orders/upsert', { method: 'POST', body: JSON.stringify(payload) });
    }

    async function bulkUpsertOrdersApi(payload) {
      return apiJson('/api/orders/bulk-upsert', { method: 'POST', body: JSON.stringify(payload) });
    }

    async function bulkUpsertCategoriesApi(payload) {
      return apiJson('/api/categories/bulk-upsert', { method: 'POST', body: JSON.stringify(payload) });
    }

    async function bulkUpsertProductsApi(payload) {
      return apiJson('/api/products/bulk-upsert', { method: 'POST', body: JSON.stringify(payload) });
    }

    async function clearOrdersApi(date) {
      return apiJson(`/api/orders?date=${encodeURIComponent(date)}`, { method: 'DELETE' });
    }

    function applyOrderRows(orderRecords) {
      const incomingRows = ordersToRows(orderRecords);
      if (incomingRows.length === 0) {
        const hasProtected = rows.value.some((row) => row.isDirty || dirtyRows.has(row.id) || activeEditingCell.value?.rowId === row.id);
        if (hasProtected) return;
      }
      const incomingByProductId = new Map(incomingRows.map((row) => [String(row.productId || ''), row]));
      const nextRows = [];
      rows.value.forEach((localRow) => {
        const key = String(localRow.productId || '');
        const incoming = incomingByProductId.get(key);
        const isLocked = Boolean(localRow.isDirty) || dirtyRows.has(localRow.id) || activeEditingCell.value?.rowId === localRow.id;
        if (incoming) {
          nextRows.push(isLocked ? localRow : incoming);
          if (!isLocked) incomingByProductId.delete(key);
          return;
        }
        if (isLocked || !key) nextRows.push(localRow);
      });
      incomingByProductId.forEach((incoming) => nextRows.push(incoming));
      rows.value = nextRows.length ? nextRows : [emptyRow()];
      rows.value.forEach((row) => {
        ensureRowSchools(row);
        recalcRow(row);
      });
      parserPreview.value = summaryList.value;
    }

    async function fetchDailyOrders(dateValue = deliveryDate.value) {
      try {
        setStatus('Đang đồng bộ', 'API', `Đang lấy đơn hàng ngày ${dateValue}.`);
        const orderRows = await fetchOrders(dateValue);
        skipNextSync = true;
        applyingRemote = true;
        applyOrderRows(Array.isArray(orderRows) ? orderRows : []);
        applyingRemote = false;
        nextTick(() => { skipNextSync = false; });
        setStatus('Sẵn sàng', 'API', `Đã tải đơn hàng ngày ${dateValue}.`);
        persistLocal();
        return true;
      } catch (error) {
        applyingRemote = false;
        skipNextSync = false;
        logError('fetchDailyOrders', error);
        addToast('Không lấy được đơn hàng theo ngày', 'error');
        setStatus('Offline', 'Local cache', 'Backend không khả dụng; đang dùng dữ liệu local.');
        return false;
      }
    }

    async function changeDeliveryDate() {
      dirtyRows.clear();
      activeEditingCell.value = null;
      rows.value = [emptyRow()];
      persistLocal();
      await fetchDailyOrders();
    }

    async function pullApiState(categoryRowsOverride = null) {
      try {
        setStatus('Đang đồng bộ', 'API', 'Đang lấy dữ liệu mới từ backend.');
        const [schoolRows, productRows, categoryRows, stockRows, orderRows] = await Promise.all([
          fetchSchools(),
          fetchProducts(),
          Array.isArray(categoryRowsOverride) ? Promise.resolve(categoryRowsOverride) : fetchCategories(),
          fetchStock(),
          fetchOrders(deliveryDate.value)
        ]);

        skipNextSync = true;
        applyingRemote = true;
        if (Array.isArray(schoolRows)) {
          if (!schoolRows.length) {
            schools.value = [];
          } else {
          const byId = new Map(schoolRows.map((school) => {
            const next = {
              ...school,
              code: school.code || school.id,
              id: school.id || crypto.randomUUID()
            };
            return [schoolKey(next), next];
          }));
          const nextSchools = [];
          schools.value.forEach((localSchool) => {
            const key = schoolKey(localSchool);
            const incoming = byId.get(key);
            const isLocked = false;
            if (incoming) {
              nextSchools.push(incoming);
              byId.delete(key);
              return;
            }
            if (!key || isLocked) nextSchools.push(localSchool);
          });
          byId.forEach((school) => nextSchools.push(school));
          schools.value = nextSchools;
          }
        }
        if (Array.isArray(productRows)) {
          if (!productRows.length) {
            products.value = [];
          } else {
            const byId = new Map(productRows.map((product) => {
              const next = {
                ...product,
                code: product.code || product.shortcut || '',
                id: product.id || crypto.randomUUID(),
                isDirty: false
              };
              return [productKey(next), next];
            }));
            const nextProducts = [];
            products.value.forEach((localProduct) => {
              const key = productKey(localProduct);
              const incoming = byId.get(key);
              const isLocked = false;
              if (incoming) {
                nextProducts.push(incoming);
                byId.delete(key);
                return;
              }
              if (!key || isLocked) nextProducts.push(localProduct);
            });
            byId.forEach((product) => nextProducts.push(product));
            products.value = nextProducts;
          }
        }
        if (Array.isArray(categoryRows)) {
          applyCategoryRows(categoryRows);
        }
        if (stockRows && typeof stockRows === 'object') stockMap.value = normalizeStockMap(stockRows);
        if (Array.isArray(orderRows)) applyOrderRows(orderRows);
        applyingRemote = false;
        nextTick(() => { skipNextSync = false; });
        setStatus('Sẵn sàng', 'API', 'Đã đồng bộ dữ liệu thủ công.');
        persistLocal();
        return true;
      } catch (error) {
        applyingRemote = false;
        skipNextSync = false;
        logError('pullApiState', error);
        addToast('Không lấy được dữ liệu từ backend', 'error');
        setStatus('Offline', 'Local cache', 'Backend không khả dụng; đang dùng local cache.');
        return false;
      }
    }

    async function initializeAuthenticatedState() {
      if (!authToken.value) return;
      try {
        const categoryRows = await fetchCategories();
        applyCategoryRows(categoryRows);
        await pullApiState(categoryRows);
      } catch (error) {
        logError('initializeAuthenticatedState', error);
        addToast('Không thể tải dữ liệu khởi tạo', 'error');
      }
    }

    function rowToDeltaOrderRecords(row) {
      const product = resolveProduct(row.productId || row.shortcut);
      if (!product) return [];
      return schools.value.map((school) => ({
        delivery_date: deliveryDate.value,
        product_id: String(productKey(product)),
        school_id: String(schoolKey(school)),
        qty: round3(row.schoolQtys?.[schoolKey(school)]),
        batches: (row.schoolBatches?.[schoolKey(school)] || []).map((batch) => ({
          ...batch,
          daily_order_id: ensureSchoolOrderId(row, schoolKey(school))
        }))
      }));
    }

    async function pushApiState(dirtyOrderRows, dirtyProductRecords, dirtyCategoryRecords) {
      for (const school of schools.value) {
        const previousId = schoolKey(school);
        const response = await saveSchoolApi({
          code: school.code || school.id,
          name: school.name,
          bg_color: school.bg_color,
          text_color: school.text_color,
          border_color: school.border_color,
          icon: school.icon
        });
        const saved = response?.data || response;
        if (saved?.id && String(saved.id) !== previousId) {
          rows.value.forEach((row) => {
            if (Object.prototype.hasOwnProperty.call(row.schoolQtys || {}, previousId)) {
              row.schoolQtys[saved.id] = row.schoolQtys[previousId];
              delete row.schoolQtys[previousId];
            }
          });
          school.id = saved.id;
        }
      }
      const categoryPayload = dirtyCategoryRecords.map((category) => ({
        id: String(category.id),
        name: category.name.trim()
      }));
      const productPayload = dirtyProductRecords.map((product) => ({
        id: String(product.id),
        code: norm(product.code),
        name: product.name.trim(),
        unit: product.unit.trim() || '-',
        price: num(product.price),
        category_id: product.category_id || null
      }));
      const orderRecords = dirtyOrderRows.flatMap((row) => rowToDeltaOrderRecords(row));
      const [categoryResponse, productResponse, orderResponse] = await Promise.all([
        dirtyCategoryRecords.length ? bulkUpsertCategoriesApi(categoryPayload) : Promise.resolve(null),
        dirtyProductRecords.length ? bulkUpsertProductsApi(productPayload) : Promise.resolve(null),
        dirtyOrderRows.length ? bulkUpsertOrdersApi(orderRecords) : Promise.resolve(null)
      ]);
      for (const product of dirtyProductRecords) {
        const previousId = productKey(product);
        if (previousId) product.id = previousId;
      }
      const stockTasks = Object.entries(stockMap.value).map(([product_id, qtyValue]) => {
        const product = resolveProduct(product_id);
        return saveStockApi({
          product_id: product?.id || product_id,
          qty: num(qtyValue)
        });
      });
      await Promise.all(stockTasks);
      dirtyCategoryRecords.forEach((category) => { category.isDirty = false; });
      dirtyProductRecords.forEach((product) => { product.isDirty = false; });
      dirtyOrderRows.forEach((row) => clearRowDirty(row));
      return { ...(orderResponse || {}), categoryResponse, productResponse };
    }

    async function syncNow() {
      if (syncing) return;
      syncing = true;
      try {
        persistLocal();
        const dirtyOrderRows = rows.value.filter((row) => row.isDirty || dirtyRows.has(row.id));
        const dirtyProductRecords = products.value.filter((product) => product.isDirty);
        const dirtyCategoryRecords = categories.value.filter((category) => category.isDirty);
        if (!dirtyOrderRows.length && !dirtyProductRecords.length && !dirtyCategoryRecords.length) {
          addToast('Dữ liệu đã được tối ưu, không có gì cần đồng bộ thêm!', 'success');
          return;
        }
        if (!navigator.onLine) {
          setStatus('Offline', 'Local cache', 'Thiết bị offline; giữ dữ liệu local.');
          addToast('Đang offline, dùng dữ liệu local', 'warn');
          return;
        }
        setStatus('Đang đồng bộ', 'API', 'Đang đẩy local lên backend.');
        const response = await pushApiState(dirtyOrderRows, dirtyProductRecords, dirtyCategoryRecords);
        dirtyRows.clear();
        const changedCount = dirtyOrderRows.length + dirtyProductRecords.length + dirtyCategoryRecords.length;
        addToast(`Đồng bộ thành công ${changedCount} bản ghi thay đổi lên Cloud!`, 'success');
      } catch (error) {
        logError('syncNow', error);
        addToast('Đồng bộ thất bại', 'error');
        setStatus('Offline', 'Local cache', 'Không đồng bộ được; xem debug log.');
      } finally {
        syncing = false;
        persistLocal();
      }
    }

    function scheduleSync() {
      persistLocal();
    }

    async function manuallySyncAllData() {
      if (isSyncingManual.value) return;
      isSyncingManual.value = true;
      try {
        await syncNow();
      } finally {
        isSyncingManual.value = false;
      }
    }

    async function installApp() {
      if (!deferredPrompt.value) return;
      const promptEvent = deferredPrompt.value;
      deferredPrompt.value = null;
      await promptEvent.prompt();
      await promptEvent.userChoice;
    }

    function dismissIOSGuide() {
      iosGuideDismissed.value = true;
    }

    function saveProduct() {
      const code = norm(productForm.value.code);
      if (!code || !productForm.value.name.trim()) return;
      const existing = products.value.find((product) => norm(product.code) === code || norm(product.id) === code);
      const record = {
        id: existing?.id || crypto.randomUUID(),
        isDirty: true,
        code,
        name: productForm.value.name.trim(),
        unit: productForm.value.unit.trim() || '-',
        price: num(productForm.value.price),
        category_id: productForm.value.category_id || null,
        created_at: today
      };
      const index = products.value.findIndex((product) => norm(product.code) === code || norm(product.id) === code);
      if (index >= 0) products.value[index] = { ...products.value[index], ...record };
      else products.value.unshift(record);
      rows.value.forEach((row) => {
        if (norm(row.shortcut) === code) pickProduct(row, record);
      });
      resetProductForm();
      scheduleSync();
    }

    function editProduct(product) {
      editingProduct.value = true;
      productForm.value = clone(product);
    }

    function resetProductForm() {
      editingProduct.value = false;
      productForm.value = { code: '', name: '', unit: '', price: 0, category_id: '' };
    }

    function saveCategory() {
      const name = categoryForm.value.name.trim();
      if (!name) return;
      if (isSubmittingCategory.value) return;
      isSubmittingCategory.value = true;
      try {
        const existingIndex = categories.value.findIndex((item) => norm(item.name) === norm(name));
        if (existingIndex >= 0) {
          categories.value[existingIndex] = { ...categories.value[existingIndex], name, isDirty: true };
        } else {
          categories.value.push({ id: crypto.randomUUID(), name, isDirty: true, created_at: today });
        }
        categoryForm.value = { name: '' };
        scheduleSync();
      } finally {
        isSubmittingCategory.value = false;
      }
    }

    function editCategory(category) {
      editingCategoryId.value = category.id;
      categoryDraftName.value = category.name;
    }

    function updateCategory(category) {
      const name = categoryDraftName.value.trim();
      if (!name) return;
      try {
        const index = categories.value.findIndex((item) => String(item.id) === String(category.id));
        if (index >= 0) categories.value[index] = { ...categories.value[index], name, isDirty: true };
        editingCategoryId.value = '';
        categoryDraftName.value = '';
        scheduleSync();
      } catch (error) {
        logError('updateCategory', error);
        addToast(`Không thể cập nhật nhóm hàng: ${error.message}`, 'error');
      }
    }

    function cancelCategoryEdit() {
      editingCategoryId.value = '';
      categoryDraftName.value = '';
    }

    function promptDeleteCategory(category) {
      categoryToDelete.value = category;
      categoryDeleteConfirmText.value = '';
      showCategoryDeleteModal.value = true;
    }

    function closeCategoryDeleteModal() {
      showCategoryDeleteModal.value = false;
      categoryToDelete.value = null;
      categoryDeleteConfirmText.value = '';
    }

    async function confirmDeleteCategory() {
      if (categoryDeleteConfirmText.value !== 'XAC NHAN XOA NHOM' || !categoryToDelete.value) return;
      const category = categoryToDelete.value;
      try {
        await deleteCategoryApi(category.id);
        categories.value = categories.value.filter((item) => String(item.id) !== String(category.id));
        products.value.forEach((product) => {
          if (String(product.category_id) === String(category.id)) product.category_id = null;
        });
        closeCategoryDeleteModal();
        scheduleSync();
        addToast(`Đã xóa nhóm ${category.name}`, 'success');
      } catch (error) {
        logError('deleteCategory', error);
        addToast(`Không thể xóa nhóm hàng: ${error.message}`, 'error');
      }
    }

    async function deleteProduct(code) {
      if (!confirm(`Xoá sản phẩm ${code.toUpperCase()}?`)) return;
      const product = resolveProduct(code);
      products.value = products.value.filter((product) => norm(product.code) !== norm(code) && norm(product.id) !== norm(code));
      delete stockMap.value[code];
      if (product?.id) delete stockMap.value[product.id];
      rows.value.forEach((row) => {
        if (norm(row.shortcut) === norm(code)) {
          row.shortcut = '';
          row.searchQuery = '';
          row.productId = '';
          row.productName = '';
          row.unit = '';
          row.price = 0;
          recalcRow(row);
        }
      });
      try {
        await deleteProductApi(code);
        addToast(`Đã xoá sản phẩm ${code.toUpperCase()}`, 'success');
      } catch (error) {
        logError('deleteProduct', error);
        addToast(`Xoá sản phẩm ${code.toUpperCase()} thất bại`, 'error');
      }
      scheduleSync();
    }

    function applySchoolTheme(themeKey) {
      const theme = themes.find((item) => item.bg_color === themeKey) || themes[0];
      schoolForm.value.bg_color = theme.bg_color;
      schoolForm.value.text_color = theme.text_color;
      schoolForm.value.border_color = theme.border_color;
      schoolForm.value.theme = theme.bg_color;
    }

    function saveSchool() {
      const code = norm(schoolForm.value.id);
      if (!code || !schoolForm.value.name.trim()) return;
      const existing = schools.value.find((school) => norm(school.code) === code || norm(school.id) === code);
      const record = {
        id: existing?.id || crypto.randomUUID(),
        code,
        name: schoolForm.value.name.trim(),
        bg_color: schoolForm.value.bg_color,
        text_color: schoolForm.value.text_color,
        border_color: schoolForm.value.border_color,
        icon: schoolForm.value.icon,
        created_at: today
      };
      const index = schools.value.findIndex((school) => norm(school.code) === code || norm(school.id) === code);
      if (index >= 0) schools.value[index] = { ...schools.value[index], ...record };
      else schools.value.unshift(record);
      rows.value.forEach((row) => {
        const rowKey = schoolKey(record);
        if (!row.schoolQtys[rowKey]) row.schoolQtys[rowKey] = 0;
        if (!row.schoolBatches[rowKey]) row.schoolBatches[rowKey] = [];
      });
      resetSchoolForm();
      scheduleSync();
    }

    function editSchool(school) {
      editingSchool.value = true;
      schoolForm.value = clone({ ...school, id: school.code || school.id, theme: school.bg_color });
    }

    function resetSchoolForm() {
      editingSchool.value = false;
      schoolForm.value = { id: '', name: '', bg_color: 'bg-sky-50', text_color: 'text-sky-800', border_color: 'border-sky-200', icon: 'fa-school', theme: 'bg-sky-50' };
    }

    function promptDeleteSchool(school) {
      schoolToDelete.value = school;
      schoolDeleteConfirmText.value = '';
      showSchoolDeleteModal.value = true;
    }

    function closeSchoolDeleteModal() {
      showSchoolDeleteModal.value = false;
      schoolToDelete.value = null;
      schoolDeleteConfirmText.value = '';
    }

    async function confirmDeleteSchool() {
      const expected = 'XAC NHAN XOA';
      const input = schoolDeleteConfirmText.value.replace(/\s+/g, ' ').trim();
      if (input !== expected) {
        addToast('Bạn phải nhập đúng "XAC NHAN XOA" để xác nhận xóa', 'warn');
        return;
      }
      const id = schoolToDelete.value?.id || schoolToDelete.value?.code;
      closeSchoolDeleteModal();
      if (id) await executeDeleteSchool(id);
    }

    async function executeDeleteSchool(id) {
      const target = resolveSchool(id);
      schools.value = schools.value.filter((school) => norm(school.id) !== norm(id) && norm(school.code) !== norm(id));
      rows.value.forEach((row) => {
        if (row.schoolQtys) {
          delete row.schoolQtys[id];
          if (target) delete row.schoolQtys[schoolKey(target)];
        }
        if (row.schoolBatches) {
          delete row.schoolBatches[id];
          if (target) delete row.schoolBatches[schoolKey(target)];
        }
        recalcRow(row);
      });
      try {
        await deleteSchoolApi(id);
        addToast(`Đã xoá trường ${id}`, 'success');
      } catch (error) {
        logError('executeDeleteSchool', error);
        addToast(`Xoá trường ${id} thất bại`, 'error');
      }
      scheduleSync();
    }

    function addDefaultSchool() {
      const theme = themes[Math.floor(Math.random() * themes.length)];
      schoolForm.value = {
        id: `school_${Date.now()}`,
        name: 'Trường mới',
        bg_color: theme.bg_color,
        text_color: theme.text_color,
        border_color: theme.border_color,
        icon: 'fa-school',
        theme: theme.bg_color
      };
      saveSchool();
    }

    function saveStock() {
      const code = norm(stockForm.value.product_code);
      if (!code) return;
      const product = resolveProduct(code);
      if (!product) return;
      stockMap.value = { ...stockMap.value, [product.id]: num(stockForm.value.qty) };
      stockForm.value = { product_code: '', qty: 0 };
      scheduleSync();
    }

    async function adjustStock(product, delta) {
      if (!product?.id) return;
      const nextQty = Math.max(0, round3(stockValue(product) + delta));
      skipNextSync = true;
      stockMap.value = { ...stockMap.value, [product.id]: nextQty };
      persistLocal();
      addToast(`Đã cập nhật tồn kho ${product.code} ở local; bấm Đồng bộ thủ công để lưu cloud`, 'info');
    }

    function clearExcelStaging(keepSummary = false) {
      stagedOrders.value = [];
      quarantinedNewProducts.value = [];
      quarantinedNewSchools.value = [];
      showNewProductsModal.value = false;
      if (!keepSummary) importSummary.value = null;
      if (excelFileInput.value) excelFileInput.value.value = '';
    }

    function resetExcelImport() {
      clearExcelStaging(false);
    }

    function openSingleSchoolImportModal(schoolId) {
      singleSchoolImportSchoolId.value = schoolId;
      singleSchoolImportTab.value = 'file';
      singleSchoolImportText.value = '';
      singleSchoolImportModal.value = true;
    }

    function closeSingleSchoolImportModal() {
      singleSchoolImportModal.value = false;
      singleSchoolImportText.value = '';
      if (singleSchoolImportFileInput.value) singleSchoolImportFileInput.value.value = '';
    }

    function schoolSlug(value) {
      return norm(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || `school-${Date.now()}`;
    }

    function schoolHintFromText(text, fileName = '') {
      const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const textMatch = lines.map((line) => line.match(/^(?:đơn\s*hàng\s*)?(?:trường|school)\s*[:\-]?\s*(.+)$/i)).find(Boolean);
      const fileMatch = String(fileName || '').match(/(?:đơn[-_\s]*hàng[-_\s]*)?(?:trường|school)[-_\s]+(.+?)\.(xlsx|xls)$/i);
      const name = String(textMatch?.[1] || fileMatch?.[1] || '').trim().replace(/\.(xlsx|xls)$/i, '').trim();
      if (!name) return null;
      const existing = schoolFromHeader(name);
      if (existing) return { ref: schoolKey(existing), existing };
      return { ref: `pending-school-${uid()}`, code: schoolSlug(name), name, bg_color: 'bg-sky-50', text_color: 'text-sky-800', border_color: 'border-sky-200', icon: 'fa-school' };
    }

    function targetSchoolHint(schoolId, sourceText = '', fileName = '') {
      if (schoolId) {
        const school = resolveSchool(schoolId);
        if (school) return { ref: schoolKey(school), existing: school };
      }
      return schoolHintFromText(sourceText, fileName);
    }

    function stageSingleSchoolRows(importedRows, schoolHint) {
      if (!schoolHint) throw new Error('Không xác định được trường nhận đơn. Hãy mở nhập từ cột trường hoặc thêm tên trường vào file/văn bản.');
      if (!schoolHint.existing) {
        const duplicate = quarantinedNewSchools.value.find((school) => school.ref === schoolHint.ref);
        if (!duplicate) quarantinedNewSchools.value.push({ ...schoolHint, theme: schoolHint.bg_color });
      }
      const records = importedRows.filter((item) => item.code && num(item.qty) > 0).map((item) => ({
        code: norm(item.code),
        name: item.name || '',
        unit: item.unit || '-',
        price: num(item.price),
        allocations: { [schoolHint.ref]: round3(num(item.qty)) },
        productId: resolveProduct(item.code) ? productKey(resolveProduct(item.code)) : ''
      }));
      stagedOrders.value.push(...records.filter((item) => item.productId));
      records.filter((item) => !item.productId).forEach((item) => {
        const existing = quarantinedNewProducts.value.find((product) => norm(product.code) === item.code && product.schoolRef === schoolHint.ref);
        if (existing) {
          existing.allocationRowData[schoolHint.ref] = round3(num(existing.allocationRowData[schoolHint.ref]) + num(item.allocations[schoolHint.ref]));
          return;
        }
        quarantinedNewProducts.value.push({
          ...item,
          schoolRef: schoolHint.ref,
          allocationRowData: { ...item.allocations }
        });
      });
      importSummary.value = {
        totalRows: (importSummary.value?.totalRows || 0) + records.length,
        newProducts: quarantinedNewProducts.value.length,
        newSchools: quarantinedNewSchools.value.length,
        totalQty: round3((importSummary.value?.totalQty || 0) + records.reduce((sum, item) => sum + num(item.qty || Object.values(item.allocations)[0]), 0)),
        totalRevenue: Math.round((importSummary.value?.totalRevenue || 0) + records.reduce((sum, item) => sum + num(item.qty || Object.values(item.allocations)[0]) * num(item.price), 0))
      };
      if (quarantinedNewProducts.value.length || quarantinedNewSchools.value.length) showNewProductsModal.value = true;
      else {
        mergeStagedOrders();
        closeSingleSchoolImportModal();
        clearExcelStaging(true);
        addToast(`Đã nhập ${records.length} dòng cho trường`, 'success');
      }
    }

    function parseSingleSchoolText(text, schoolId = '') {
      const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const schoolHint = targetSchoolHint(schoolId, text);
      const records = [];
      lines.forEach((line) => {
        if (/^(đơn\s*hàng\s*)?(trường|school)\b/i.test(line)) return;
        const match = line.match(/^([^\s:;,\t]+)\s*(?::|;|\t|\s+)\s*([\d.,]+)/);
        if (!match) return;
        records.push({ code: match[1], qty: num(match[2]), name: '', unit: '-', price: 0 });
      });
      if (!records.length) throw new Error('Không tìm thấy dòng sản phẩm hợp lệ. Ví dụ: tv 10 hoặc cl: 5');
      stageSingleSchoolRows(records, schoolHint);
    }

    function parseSingleSchoolSheet(matrix, fileName, schoolId = '') {
      if (matrix.length < 2) throw new Error('Tệp Excel không có dữ liệu hàng.');
      const headers = matrix[0].map((value) => norm(value));
      const findColumn = (terms, fallback) => headers.findIndex((header) => terms.some((term) => header.includes(term))) >= 0
        ? headers.findIndex((header) => terms.some((term) => header.includes(term)))
        : fallback;
      const codeIndex = findColumn(['mã hàng', 'mã sản phẩm', 'mã', 'code', 'shortcut'], 0);
      const nameIndex = findColumn(['tên hàng', 'tên sản phẩm', 'tên', 'name'], 1);
      const unitIndex = findColumn(['đvt', 'đơn vị', 'unit'], 2);
      const priceIndex = findColumn(['đơn giá', 'giá', 'price'], 3);
      const qtyIndex = findColumn(['số lượng', 'sl', 'qty', 'quantity'], 4);
      const sourceText = headers.join(' ');
      const schoolHint = targetSchoolHint(schoolId, sourceText, fileName);
      const records = matrix.slice(1).filter((row) => String(row[codeIndex] ?? '').trim()).map((row) => ({
        code: row[codeIndex],
        name: String(row[nameIndex] ?? '').trim(),
        unit: String(row[unitIndex] ?? '').trim() || '-',
        price: num(row[priceIndex]),
        qty: num(row[qtyIndex])
      }));
      stageSingleSchoolRows(records, schoolHint);
    }

    function parseSingleSchoolMultiDateExcel(sheetData, targetSchoolId) {
      const targetSchool = resolveSchool(targetSchoolId);
      if (!targetSchool?.id) {
        throw new Error('Không xác định được trường đích hợp lệ để đồng bộ dữ liệu đa ngày.');
      }

      let activeDateContext = null;
      const uniqueRecordsMap = new Map();
      const dateContexts = new Set();
      let skippedRows = 0;

      console.info(`[Ingestion Core] Starting parsing engine for total raw rows: ${sheetData.length}`);
      for (let index = 0; index < sheetData.length; index += 1) {
        const row = sheetData[index];
        if (!Array.isArray(row) || row.length === 0) continue;

        const dateAnchor = String(row[0] ?? '').trim();
        const dateMatch = dateAnchor.match(/ngày\s+(\d{1,2})\/(\d{1,2})\/(\d{2})/i);
        if (dateMatch) {
          const [, day, month, year] = dateMatch;
          activeDateContext = `20${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
          dateContexts.add(activeDateContext);
          console.info(`[Ingestion Core] Switched active date anchor to: ${activeDateContext}`);
        }

        const shortcut = norm(row[1]);
        if (!shortcut || shortcut === 'nan') continue;
        if (!activeDateContext) {
          skippedRows += 1;
          continue;
        }

        const matchedProduct = products.value.find((product) => norm(product.code || product.shortcut) === shortcut);
        if (!matchedProduct?.id) {
          skippedRows += 1;
          console.warn(`[Ingestion Warning] Shortcut '${shortcut}' không tồn tại trong danh mục gốc. Bỏ qua dòng.`);
          continue;
        }

        const qty = round3(num(row[4]));
        const productId = String(matchedProduct.id);
        const schoolId = String(targetSchool.id);
        const compoundKey = `${activeDateContext}_${productId}_${schoolId}`;
        const existingRecord = uniqueRecordsMap.get(compoundKey);
        if (existingRecord) {
          existingRecord.qty = round3(existingRecord.qty + qty);
          console.info(
            `[Ingestion Aggregator] Summed duplicate item line: ${shortcut} on ${activeDateContext} -> ${existingRecord.qty}`
          );
          continue;
        }

        uniqueRecordsMap.set(compoundKey, {
          delivery_date: activeDateContext,
          product_id: productId,
          school_id: schoolId,
          qty
        });
      }

      const allocationPayloads = Array.from(uniqueRecordsMap.values());
      console.info(
        `[Ingestion Core] Parsing complete. Aggregation layer compiled ${allocationPayloads.length} distinct database records.`
      );

      return {
        allocationPayloads,
        dateContexts,
        skippedRows
      };
    }

    async function handleSingleSchoolExcelUpload(event) {
      const file = event.target.files?.[0];
      if (!file || !window.XLSX) return;
      try {
        const buffer = await file.arrayBuffer();
        const workbook = window.XLSX.read(buffer, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const matrix = window.XLSX.utils.sheet_to_json(sheet, {
          header: 1,
          blankrows: true,
          defval: ''
        });
        const hasDateAnchors = matrix.some((row) => /ngày\s+\d{1,2}\/\d{1,2}\/\d{2}/i.test(String(row?.[0] ?? '')));
        if (hasDateAnchors) {
          const { allocationPayloads, dateContexts, skippedRows } = parseSingleSchoolMultiDateExcel(
            matrix,
            singleSchoolImportSchoolId.value
          );
          if (!allocationPayloads.length) {
            throw new Error('Không tìm thấy bản ghi sản phẩm hợp lệ trong các khối ngày của tệp.');
          }

          await bulkUpsertOrdersApi(allocationPayloads);
          await fetchDailyOrders(deliveryDate.value);
          persistLocal();
          closeSingleSchoolImportModal();
          const skippedSuffix = skippedRows ? ` Bỏ qua ${skippedRows} dòng không khớp danh mục.` : '';
          addToast(
            `Nạp tệp thành công! Đã đồng bộ ${allocationPayloads.length} bản ghi của trường lên hệ thống qua ${dateContexts.size} ngày dữ liệu.${skippedSuffix}`,
            'success'
          );
          return;
        }
        parseSingleSchoolSheet(matrix, file.name, singleSchoolImportSchoolId.value);
        if (!showNewProductsModal.value) closeSingleSchoolImportModal();
      } catch (error) {
        logError('handleSingleSchoolExcelUpload', error);
        addToast(`Không thể đọc đơn trường: ${error.message}`, 'error');
      }
    }

    function submitSingleSchoolTextImport() {
      try {
        parseSingleSchoolText(singleSchoolImportText.value, singleSchoolImportSchoolId.value);
        if (!showNewProductsModal.value) closeSingleSchoolImportModal();
      } catch (error) {
        logError('submitSingleSchoolTextImport', error);
        addToast(`Không thể phân tích văn bản: ${error.message}`, 'error');
      }
    }

    function applySchoolThemeToReview(school) {
      const theme = themes.find((item) => item.bg_color === school.theme) || themes[0];
      school.bg_color = theme.bg_color;
      school.text_color = theme.text_color;
      school.border_color = theme.border_color;
    }

    function sanitizeCatalogPrice(value) {
      const raw = String(value ?? '').replace(/[\u0000-\u001f\uE000-\uF8FF]/g, ' ').trim();
      if (/theo\s*thời\s*giá|market\s*price/i.test(raw)) return { price: 0, isMarketPrice: true };
      const numeric = raw.match(/[\d.,]+/g)?.join('') || '';
      if (!numeric) return { price: 0, isMarketPrice: false };
      let normalized = numeric;
      if (normalized.includes('.') && normalized.includes(',')) normalized = normalized.replace(/[.,](?=\d{3}(?:\D|$))/g, '');
      else if (normalized.includes(',') && /,\d{3}$/.test(normalized)) normalized = normalized.replace(/,/g, '');
      else normalized = normalized.replace(',', '.');
      return { price: num(normalized), isMarketPrice: false };
    }

    function isCatalogCategoryLabel(value) {
      const text = String(value || '').trim();
      return Boolean(text && (/^(?:\*+\s*)?(?:I{1,3}|IV|V)\b/i.test(text) || /^\*/.test(text)));
    }

    function catalogColumnIndex(headers, terms, fallback) {
      const index = headers.findIndex((header) => terms.some((term) => header.includes(term)));
      return index >= 0 ? index : fallback;
    }

    function parseCatalogSheet(matrix) {
      if (!Array.isArray(matrix) || matrix.length < 2) throw new Error('Tệp báo giá không có đủ dữ liệu.');
      const headers = matrix[0].map((value) => norm(value));
      const codeIndex = catalogColumnIndex(headers, ['mã hàng', 'mã sản phẩm', 'mã', 'code'], 0);
      const nameIndex = catalogColumnIndex(headers, ['tên hàng', 'tên sản phẩm', 'tên', 'name'], 1);
      const unitIndex = catalogColumnIndex(headers, ['đvt', 'đơn vị', 'unit'], 2);
      const priceIndex = catalogColumnIndex(headers, ['đơn giá', 'giá', 'price'], 3);
      let currentCategoryName = '';
      const parsed = [];
      matrix.slice(1).forEach((row, index) => {
        const codeRaw = String(row[codeIndex] ?? '').trim();
        const nameRaw = String(row[nameIndex] ?? '').trim();
        const unitRaw = String(row[unitIndex] ?? '').trim();
        const priceRaw = String(row[priceIndex] ?? '').trim();
        if (!unitRaw && !priceRaw && (isCatalogCategoryLabel(codeRaw) || isCatalogCategoryLabel(nameRaw))) {
          currentCategoryName = [codeRaw, nameRaw].filter(Boolean).join(' ').replace(/^\*+\s*/, '').trim();
          return;
        }
        if (!unitRaw) return;
        const priceInfo = sanitizeCatalogPrice(priceRaw);
        const cleanedCode = norm(codeRaw);
        const requiresShortcut = !cleanedCode || /^\d+(?:[.,]\d+)?$/.test(cleanedCode);
        const product = !requiresShortcut ? resolveProduct(cleanedCode) : null;
        const suggestedCode = requiresShortcut ? generateShortcutFromName(nameRaw) : cleanedCode;
        parsed.push({
          id: `catalog-row-${index}`,
          originalCode: codeRaw,
          code: suggestedCode,
          name: nameRaw,
          unit: unitRaw,
          price: priceInfo.price,
          isMarketPrice: priceInfo.isMarketPrice,
          categoryName: currentCategoryName || 'Chưa phân nhóm',
          category_id: product?.category_id || '',
          existingProductId: product ? productKey(product) : '',
          requiresShortcut,
          suggestedShortcut: requiresShortcut
        });
      });
      if (!parsed.length) throw new Error('Không nhận diện được dòng sản phẩm. Hãy kiểm tra cột ĐVT.');
      const categoryNames = [...new Set(parsed.map((item) => item.categoryName).filter(Boolean))];
      return { parsed, categoryNames };
    }

    async function handleCatalogExcelUpload(event) {
      const file = event.target.files?.[0];
      if (!file || !window.XLSX) return;
      try {
        const workbook = window.XLSX.read(await file.arrayBuffer(), { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const matrix = window.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        const result = parseCatalogSheet(matrix);
        catalogReviewItems.value = result.parsed;
        catalogReviewCategories.value = result.categoryNames.map((name) => ({
          name,
          id: categories.value.find((category) => norm(category.name) === norm(name))?.id || '',
          isNew: !categories.value.some((category) => norm(category.name) === norm(name))
        }));
        catalogImportSummary.value = {
          totalRows: result.parsed.length,
          totalCategories: result.categoryNames.length,
          newItems: result.parsed.filter((item) => !item.existingProductId || item.requiresShortcut).length,
          marketPriceItems: result.parsed.filter((item) => item.isMarketPrice).length
        };
        showCatalogReviewModal.value = true;
      } catch (error) {
        logError('handleCatalogExcelUpload', error);
        addToast(`Không thể đọc báo giá: ${error.message}`, 'error');
      }
    }

    function resetCatalogImport(keepSummary = false) {
      showCatalogReviewModal.value = false;
      catalogReviewItems.value = [];
      catalogReviewCategories.value = [];
      if (!keepSummary) catalogImportSummary.value = null;
      if (catalogFileInput.value) catalogFileInput.value.value = '';
    }

    async function approveCatalogImport() {
      try {
        if (!catalogImportReady.value) throw new Error('Mã số/trống hoặc mã trùng: hãy kiểm tra lại shortcut trong bảng duyệt.');
        const categoryIds = new Map();
        for (const category of catalogReviewCategories.value) {
          const name = category.name.trim();
          if (!name) throw new Error('Tên nhóm hàng không được để trống.');
          const existing = categories.value.find((item) => norm(item.name) === norm(name));
          if (existing) {
            categoryIds.set(category.name, existing.id);
            continue;
          }
          const response = await saveCategoryApi({ name });
          const saved = response?.data || response;
          const record = { ...saved, id: saved?.id || crypto.randomUUID(), name };
          categories.value.push(record);
          categoryIds.set(category.name, record.id);
        }
        const seenCodes = new Set(products.value.map((product) => norm(product.code)));
        const bulkPayload = catalogReviewItems.value.map((item) => {
          const code = norm(item.code);
          if (!code || !/^[a-z][a-z0-9_-]*$/i.test(code)) throw new Error(`Mã hàng không hợp lệ: ${item.originalCode || '(trống)'}`);
          if (seenCodes.has(code) && !item.existingProductId) throw new Error(`Mã hàng bị trùng: ${code}`);
          const categoryId = categoryIds.get(item.categoryName) || null;
          return {
            code,
            name: item.name.trim(),
            unit: item.unit.trim() || '-',
            price: num(item.price),
            category_id: categoryId
          };
        });
        const existingCodes = new Set(products.value.map((product) => norm(product.code)));
        const response = await saveProductsBulkApi(bulkPayload);
        const savedProducts = Array.isArray(response?.data) ? response.data : [];
        const savedByCode = new Map(savedProducts.map((product) => [norm(product.code), product]));
        let registered = 0;
        catalogReviewItems.value.forEach((item, index) => {
          const payload = bulkPayload[index];
          const saved = savedByCode.get(payload.code) || {};
          const product = {
            ...saved,
            id: saved.id || item.existingProductId || crypto.randomUUID(),
            ...payload,
            is_market_price: item.isMarketPrice
          };
          const productIndex = products.value.findIndex((existing) => norm(existing.code) === payload.code);
          if (productIndex >= 0) products.value[productIndex] = { ...products.value[productIndex], ...product };
          else {
            products.value.unshift(product);
            if (!existingCodes.has(payload.code)) registered += 1;
          }
          seenCodes.add(payload.code);
        });
        catalogImportSummary.value = {
          ...catalogImportSummary.value,
          totalCategories: categories.value.length,
          newItems: registered
        };
        resetCatalogImport(true);
        addToast(`Đã lưu ${registered} mặt hàng và cập nhật nhóm hàng`, 'success');
        scheduleSync();
      } catch (error) {
        logError('approveCatalogImport', error);
        addToast(`Không thể duyệt báo giá: ${error.message}`, 'error');
      }
    }

    function schoolFromHeader(header) {
      const value = norm(header);
      return schools.value.find((school) => norm(school.code) === value || norm(school.name) === value || norm(school.id) === value);
    }

    function buildImportRow(row, schoolColumns) {
      const code = norm(row[0]);
      const product = resolveProduct(code);
      const allocations = {};
      schoolColumns.forEach(({ index, school }) => {
        allocations[schoolKey(school)] = round3(num(row[index]));
      });
      return {
        code,
        name: String(row[1] ?? '').trim(),
        unit: String(row[2] ?? '').trim() || '-',
        price: num(row[3]),
        allocations,
        productId: product ? productKey(product) : ''
      };
    }

    async function handleExcelUpload(event) {
      const file = event.target.files?.[0];
      if (!file) return;
      if (!window.XLSX) {
        addToast('Chưa tải được thư viện Excel', 'error');
        return;
      }
      try {
        const buffer = await file.arrayBuffer();
        const workbook = window.XLSX.read(buffer, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const matrix = window.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        if (matrix.length < 2) throw new Error('Tệp Excel không có dữ liệu hàng.');
        const headers = matrix[0];
        const schoolColumns = headers.slice(4).map((header, offset) => ({
          index: offset + 4,
          school: schoolFromHeader(header)
        })).filter((item) => item.school);
        if (!schoolColumns.length) {
          parseSingleSchoolSheet(matrix, file.name, '');
          return;
        }

        const importedRows = matrix.slice(1)
          .filter((row) => String(row[0] ?? '').trim())
          .map((row) => buildImportRow(row, schoolColumns));
        stagedOrders.value = importedRows.filter((item) => item.productId);
        quarantinedNewProducts.value = importedRows
          .filter((item) => !item.productId)
          .map((item) => ({ ...item, allocationRowData: item.allocations }));
        importSummary.value = {
          totalRows: importedRows.length,
          newProducts: quarantinedNewProducts.value.length,
          totalQty: round3(importedRows.reduce((sum, item) => sum + Object.values(item.allocations).reduce((subtotal, value) => subtotal + num(value), 0), 0)),
          totalRevenue: Math.round(importedRows.reduce((sum, item) => sum + Object.values(item.allocations).reduce((subtotal, value) => subtotal + num(value), 0) * num(item.price), 0))
        };
        if (quarantinedNewProducts.value.length) {
          showNewProductsModal.value = true;
        } else {
          mergeStagedOrders();
          clearExcelStaging(true);
          addToast(`Đã nhập ${importedRows.length} dòng từ Excel`, 'success');
        }
      } catch (error) {
        resetExcelImport();
        logError('handleExcelUpload', error);
        addToast(`Không thể đọc tệp Excel: ${error.message}`, 'error');
      }
    }

    function mergeStagedOrders() {
      const imported = stagedOrders.value;
      imported.forEach((item) => {
        const product = resolveProduct(item.productId || item.code);
        if (!product) return;
        let row = rows.value.find((candidate) => String(candidate.productId || '') === productKey(product));
        if (!row) {
          row = emptyRow();
          schools.value.forEach((school) => { row.schoolQtys[schoolKey(school)] = 0; });
          rows.value.push(row);
        }
        pickProduct(row, product);
        schools.value.forEach((school) => {
          const key = schoolKey(school);
          row.schoolQtys[key] = round3(num(row.schoolQtys[key]) + num(item.allocations[key]));
        });
        recalcRow(row);
        markRowDirty(row);
      });
      parserPreview.value = summaryList.value;
      persistLocal();
    }

    async function approveNewProductsImport() {
      try {
        const schoolRefs = new Map();
        for (const item of quarantinedNewSchools.value) {
          const code = norm(item.code);
          const name = String(item.name || '').trim();
          if (!code || !name) throw new Error('Mỗi điểm trường mới cần có mã và tên.');
          const response = await saveSchoolApi({
            code,
            name,
            bg_color: item.bg_color,
            text_color: item.text_color,
            border_color: item.border_color,
            icon: item.icon || 'fa-school'
          });
          const school = {
            ...(response || {}),
            id: response?.id || crypto.randomUUID(),
            code,
            name,
            bg_color: item.bg_color,
            text_color: item.text_color,
            border_color: item.border_color,
            icon: item.icon || 'fa-school'
          };
          schools.value.push(school);
          schoolRefs.set(item.ref, schoolKey(school));
        }
        stagedOrders.value.forEach((item) => {
          Object.entries(item.allocations).forEach(([key, value]) => {
            if (schoolRefs.has(key)) {
              item.allocations[schoolRefs.get(key)] = value;
              delete item.allocations[key];
            }
          });
        });
        const approved = [];
        const approvedCodes = new Set(products.value.map((product) => norm(product.code)));
        for (const item of quarantinedNewProducts.value) {
          const code = norm(item.code);
          if (!code || !item.name.trim()) throw new Error('Mỗi mặt hàng mới cần có mã và tên.');
          if (approvedCodes.has(code)) {
            const duplicate = approved.find((product) => norm(product.code) === code);
            if (duplicate) throw new Error(`Mã sản phẩm bị trùng: ${code}`);
            throw new Error(`Mã sản phẩm đã tồn tại: ${code}`);
          }
          const response = await saveProductApi({
            code,
            name: item.name.trim(),
            unit: item.unit.trim() || '-',
            price: num(item.price)
          });
          const product = {
            ...(response || {}),
            id: response?.id || crypto.randomUUID(),
            code,
            name: item.name.trim(),
            unit: item.unit.trim() || '-',
            price: num(item.price),
            created_at: today
          };
          products.value.unshift(product);
          const allocations = {};
          Object.entries(item.allocationRowData || item.allocations || {}).forEach(([key, value]) => {
            allocations[schoolRefs.get(key) || key] = value;
          });
          approved.push({ ...item, productId: productKey(product), code: product.code, allocations });
          approvedCodes.add(code);
        }
        stagedOrders.value.push(...approved);
        const newProducts = approved.length;
        const newSchools = quarantinedNewSchools.value.length;
        mergeStagedOrders();
        const importedRows = stagedOrders.value;
        importSummary.value = {
          totalRows: importSummary.value?.totalRows || importedRows.length,
          newProducts,
          newSchools,
          totalQty: round3(importedRows.reduce((sum, item) => sum + Object.values(item.allocations).reduce((subtotal, value) => subtotal + num(value), 0), 0)),
          totalRevenue: Math.round(importedRows.reduce((sum, item) => sum + Object.values(item.allocations).reduce((subtotal, value) => subtotal + num(value), 0) * num(item.price), 0))
        };
        const [schoolRows, productRows] = await Promise.all([fetchSchools(), fetchProducts()]);
        if (Array.isArray(schoolRows)) schools.value = schoolRows.map((school) => ({ ...school, code: school.code || school.id }));
        if (Array.isArray(productRows)) products.value = productRows.map((product) => ({ ...product, code: product.code || product.shortcut || '' }));
        clearExcelStaging(true);
        closeSingleSchoolImportModal();
        addToast(`Đã đăng ký ${newProducts} mặt hàng, ${newSchools} điểm trường và nhập đơn hàng`, 'success');
      } catch (error) {
        logError('approveNewProductsImport', error);
        addToast(`Không thể duyệt mặt hàng mới: ${error.message}`, 'error');
      }
    }

    async function fillParserFromClipboard() {
      try {
        parserText.value = await navigator.clipboard.readText();
      } catch (error) {
        logError('fillParserFromClipboard', error);
      }
    }

    function applyParser() {
      try {
        const lines = parserText.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        lines.forEach((line) => {
          const [rawCode, rest = ''] = line.split(':');
          const code = norm(rawCode);
          if (!code) return;
          const product = products.value.find((item) => norm(item.code) === code || norm(item.name).includes(code) || norm(item.id) === code);
          if (!product) return;
          let row = rows.value.find((item) => norm(item.shortcut) === norm(product.code) || String(item.productId || '') === productKey(product));
          if (!row) {
            row = emptyRow();
            schools.value.forEach((school) => { row.schoolQtys[schoolKey(school)] = 0; });
            rows.value.push(row);
          }
          pickProduct(row, product);
          const qtys = rest.trim().split(/\s+/).filter(Boolean).map(num);
          schools.value.forEach((school, index) => { row.schoolQtys[schoolKey(school)] = qtys[index] || 0; });
          recalcRow(row);
        });
        parserPreview.value = summaryList.value;
        scheduleSync();
      } catch (error) {
        logError('applyParser', error);
      }
    }

    function exportCSV() {
      const header = ['STT', 'Mã', 'Tên', 'ĐVT', 'Nhu cầu', 'Tồn kho', 'Thực mua', 'Đơn giá', 'Thành tiền'];
      const lines = [header.join(',')];
      summaryList.value.forEach((item, index) => {
        lines.push([
          index + 1,
          item.code,
          `"${item.name.replaceAll('"', '""')}"`,
          item.unit,
          qty(item.demandQty),
          qty(item.stockQty),
          qty(item.realBuy),
          Math.round(item.price),
          Math.round(item.subTotal)
        ].join(','));
      });
      const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `vn-food-${deliveryDate.value}.csv`;
      link.click();
      URL.revokeObjectURL(link.href);
    }

    async function copyDebugLogs() {
      const text = debugLogs.value.map((log) => `[${log.timestamp}] ${log.context}\n${log.message}\n${log.stack || ''}`).join('\n\n');
      try {
        await navigator.clipboard.writeText(text || 'Không có log');
      } catch (error) {
        logError('copyDebugLogs', error);
      }
    }

    function printAllReceipts() {
      printSchoolId.value = 'all';
      nextTick(() => window.print());
    }

    function printSchool(id) {
      const container = document.getElementById(`print-receipt-container-${id}`);
      if (!container) return;
      const iframe = document.createElement('iframe');
      iframe.setAttribute('style', 'position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;border:none;');
      document.body.appendChild(iframe);
      const doc = iframe.contentWindow.document;
      const styles = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map((link) => {
        const href = link.getAttribute('href');
        if (!href) return link.outerHTML;
        return `<link rel="stylesheet" href="${new URL(href, window.location.href).href}">`;
      }).join('');
      doc.open();
      doc.write(`
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <title>Biên bản giao hàng</title>
  ${styles}
  <style>
    body { margin: 0; padding: 0; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .no-print { display: none !important; }
    @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
  </style>
</head>
<body>
  ${container.innerHTML}
</body>
</html>
      `);
      doc.close();
      const cleanup = () => {
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      };
      iframe.contentWindow.addEventListener('afterprint', cleanup);
      setTimeout(cleanup, 60000);
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    }

    function recalcAllRows() {
      rows.value.forEach((row) => {
        ensureRowSchools(row);
        recalcRow(row);
      });
      parserPreview.value = summaryList.value;
    }

    function loadInitialState() {
      skipNextSync = true;
      hydrateLocal();
      ensureMasterDirtyFlags();
      recalcAllRows();
      nextTick(() => { skipNextSync = false; });
    }

    watch([schools, products, stockMap, rows], () => {
      persistLocal();
    }, { deep: true });
    watch([currentTab, analyticsRange, analyticsMetrics], () => nextTick(renderAnalyticsCharts), { deep: true });

    onMounted(async () => {
      handleAuthCallback();
      await loadAuthUser();
      if (authToken.value && currentUser.value) {
        if (!isAdmin.value) {
          loadInitialState();
          await initializeAuthenticatedState();
          setStatus('Sẵn sàng', 'Local cache', 'Chế độ đồng bộ thủ công. Bấm nút Đồng bộ dữ liệu để tải và lưu cloud.');
        } else {
          setStatus('Sẵn sàng', 'System Admin', 'Chế độ quản trị hệ thống.');
        }
      } else {
        resetInMemoryDatabase();
      }
      window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        deferredPrompt.value = event;
      });
      window.addEventListener('appinstalled', () => {
        deferredPrompt.value = null;
        console.info('[PWA] Ứng dụng đã được cài đặt.');
      });
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js')
          .then((registration) => {
            console.info('[PWA] Service Worker đã đăng ký:', registration.scope);
          })
          .catch((error) => {
            console.error('[PWA] Không thể đăng ký Service Worker:', error);
            logError('serviceWorker.register', error);
          });
      }
      window.addEventListener('keydown', (event) => {
        if (event.key === 'F2' && currentTab.value === 'matrix') {
          event.preventDefault();
          addRow();
        }
      });
      window.addEventListener('offline', () => {
          setStatus('Offline', 'Local cache', 'Đang offline; dữ liệu được giữ ở local.');
          addToast('Mất kết nối mạng', 'warn');
      });
      window.addEventListener('beforeunload', (event) => {
        if (pendingMutationCount.value > 0) {
          event.preventDefault();
          event.returnValue = 'Bạn có dữ liệu chưa đồng bộ lên Cloud. Bạn có chắc chắn muốn rời đi?';
        }
      });
      window.addEventListener('afterprint', () => {
        printSchoolId.value = 'all';
      });
    });

    const receiptsComputed = receipts;

    return {
      tabs,
      adminTabs,
      currentTab,
      deliveryDate,
      changeDeliveryDate,
      rows,
      schools,
      products,
      categories,
      stockMap,
      parserText,
      parserPreview,
      notifications,
      toasts,
      triggerNotification,
      dismissNotification,
      productFilter,
      productCategoryFilter,
      schoolFilter,
      stockFilter,
      matrixPage,
      stockPage,
      catalogPage,
      matrixPageCount,
      stockPageCount,
      catalogPageCount,
      paginatedRows,
      paginatedProducts,
      paginatedStockProducts,
      paginationLabel,
      previousPage,
      nextPage,
      pageSize,
      syncStatus,
      dataOrigin,
      lastSyncLabel,
      pendingMutationCount,
      isAuthenticated,
      currentUser,
      currentVendorName,
      users,
      pendingPinUsers,
      copyTempPin,
      vendors,
      selectedVendorId,
      vendorForm,
      vendorSaving,
      editingVendorId,
      editVendor,
      saveVendor,
      isAdmin,
      userRole,
      canManageCatalog,
      canMutate,
      mustChangePassword,
      userListLoading,
      vendorUserForm,
      vendorUserProvisioning,
      provisionedPin,
      subscriptionCodes,
      subscriptionMetrics,
      subscriptionCodeForm,
      subscriptionCodeGenerating,
      generateSubscriptionCode,
      renewalCode,
      redeemingCode,
      redeemSubscriptionCode,
      subscriptionWarning,
      loginForm,
      authError,
      isLoggingIn,
      showUserCPModal,
      userForm,
      passwordForm,
      userCPError,
      userCPSaving,
      showPasswordOnboarding,
      onboardingPasswordForm,
      openUserCPModal,
      closeUserCPModal,
      saveUserProfile,
      provisionVendorUser,
      createVendor,
      selectVendor,
      saveUserAssignment,
      changePassword,
      submitPasswordOnboarding,
      analyticsRange,
      analyticsMetrics,
      schoolChartCanvas,
      categoryChartCanvas,
      trendChartCanvas,
      loginWithCredentials,
      loginWithGoogle,
      logout,
      statusBanner,
      dismissStatusBanner,
      debugLogs,
      printSchoolId,
      productForm,
      categoryForm,
      isSubmittingCategory,
      categoryFilter,
      filteredCategories,
      categoryProductCount,
      categoryName,
      editingCategoryId,
      categoryDraftName,
      schoolForm,
      stockForm,
      editingProduct,
      editingSchool,
      iconOptions,
      themes,
      filteredProducts,
      filteredSchools,
      filteredStockProducts,
      receipts: receiptsComputed,
      totalBySchool,
      totalSchoolMoney,
      totalRealCost,
      totalSavedMoney,
      themeStyle,
      money,
      qty,
      activeEditingCell,
      lockCell,
      unlockCell,
      setActiveEditingCell,
      clearActiveEditingCell,
      markRowDirty,
      addRow,
      removeRow,
      clearRows,
      onShortcutInput,
      onShortcutKeydown,
      openSuggestions,
      suggestionStyle,
      closeSuggestions,
      pickProduct,
      batchPopover,
      batchForm,
      openBatchPopover,
      closeBatchPopover,
      activeBatchList,
      applyBatchAdjustment,
      deleteBatch,
      recalcRow,
      applyParser,
      fillParserFromClipboard,
      saveProduct,
      editProduct,
      resetProductForm,
      saveCategory,
      editCategory,
      updateCategory,
      cancelCategoryEdit,
      promptDeleteCategory,
      closeCategoryDeleteModal,
      confirmDeleteCategory,
      deleteProduct,
      saveSchool,
      editSchool,
      resetSchoolForm,
      promptDeleteSchool,
      closeSchoolDeleteModal,
      confirmDeleteSchool,
      executeDeleteSchool,
      addDefaultSchool,
      applySchoolTheme,
      saveStock,
      adjustStock,
      exportCSV,
      copyDebugLogs,
      scheduleSync,
      syncNow,
      printAllReceipts,
      printSchool,
      showSchoolDeleteModal,
      schoolToDelete,
      schoolDeleteConfirmText,
      num,
      isSyncingManual,
      manuallySyncAllData,
      deferredPrompt,
      installApp,
      showIOSGuide,
      dismissIOSGuide,
      showCategoryDeleteModal,
      categoryToDelete,
      categoryDeleteConfirmText,
      excelFileInput,
      handleExcelUpload,
      quarantinedNewProducts,
      quarantinedNewSchools,
      showNewProductsModal,
      stagedOrders,
      importSummary,
      approveNewProductsImport,
      resetExcelImport,
      openSingleSchoolImportModal,
      closeSingleSchoolImportModal,
      singleSchoolImportModal,
      singleSchoolImportTab,
      singleSchoolImportSchoolId,
      singleSchoolImportText,
      singleSchoolImportFileInput,
      handleSingleSchoolExcelUpload,
      submitSingleSchoolTextImport,
      applySchoolThemeToReview,
      catalogFileInput,
      showCatalogReviewModal,
      catalogReviewItems,
      catalogReviewCategories,
      catalogImportSummary,
      catalogImportInvalidItems,
      catalogImportReady,
      handleCatalogExcelUpload,
      resetCatalogImport,
      approveCatalogImport
    };
  }
}).mount('#app');
