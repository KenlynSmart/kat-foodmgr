const { createApp, ref, computed, watch, onMounted, nextTick } = Vue;

createApp({
  setup() {
    const API_BASE = '';
    const STORAGE_KEY = 'vn-food-v2-state';

    const today = new Date().toISOString().slice(0, 10);
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

    const defaultSchools = [
      { id: 'tanAn', name: 'Trường mầm non Tân An', bg_color: 'bg-sky-50', text_color: 'text-sky-800', border_color: 'border-sky-200', icon: 'fa-school', created_at: today },
      { id: 'mitSuBa', name: 'Trường mầm non Mitsuba', bg_color: 'bg-emerald-50', text_color: 'text-emerald-800', border_color: 'border-emerald-200', icon: 'fa-seedling', created_at: today },
      { id: 'lcTre', name: 'Trường mầm non Lộc Trẻ', bg_color: 'bg-amber-50', text_color: 'text-amber-800', border_color: 'border-amber-200', icon: 'fa-bowl-rice', created_at: today },
      { id: 'sunKid', name: 'Trường mầm non Sun Kid', bg_color: 'bg-violet-50', text_color: 'text-violet-800', border_color: 'border-violet-200', icon: 'fa-apple-whole', created_at: today }
    ];
    const defaultProducts = [
      { code: 'tv', name: 'Thịt vai heo VietGap', unit: 'Kg', price: 128000, created_at: today },
      { code: 'cl', name: 'Cải lá xanh', unit: 'Kg', price: 18000, created_at: today },
      { code: 'hl', name: 'Hàu sữa', unit: 'Kg', price: 96000, created_at: today },
      { code: 'tr', name: 'Trứng gà', unit: 'Quả', price: 3000, created_at: today },
      { code: 'sua', name: 'Sữa tươi', unit: 'Lít', price: 28000, created_at: today }
    ];
    const defaultStock = { tv: 3.5, cl: 8, hl: 2, tr: 100, sua: 12 };

    const emptyRow = () => ({
      id: uid(),
      shortcut: '',
      productName: '',
      unit: '',
      price: 0,
      schoolQtys: {},
      totalQty: 0,
      subTotal: 0,
      suggestions: [],
      suggestIndex: 0,
      showSuggestions: false
    });

    const state = {
      rows: [emptyRow()],
      schools: clone(defaultSchools),
      products: clone(defaultProducts),
      stockMap: clone(defaultStock),
      deliveryDate: today
    };

    const currentTab = ref('matrix');
    const rows = ref(state.rows);
    const schools = ref(state.schools);
    const products = ref(state.products);
    const stockMap = ref(state.stockMap);
    const deliveryDate = ref(state.deliveryDate);
    const parserText = ref('');
    const parserPreview = ref([]);
    const toasts = ref([]);
    const productFilter = ref('');
    const schoolFilter = ref('');
    const stockFilter = ref('');
    const syncStatus = ref('Đang tải');
    const dataOrigin = ref('Local cache');
    const statusBanner = ref('');
    const lastSyncAt = ref('');
    const debugLogs = ref([]);
    const printSchoolId = ref('all');
    const editingProduct = ref(false);
    const editingSchool = ref(false);
    const productForm = ref({ code: '', name: '', unit: '', price: 0 });
    const schoolForm = ref({ id: '', name: '', bg_color: 'bg-sky-50', text_color: 'text-sky-800', border_color: 'border-sky-200', icon: 'fa-school', theme: 'bg-sky-50' });
    const stockForm = ref({ product_code: '', qty: 0 });

    let syncing = false;
    let syncTimer = null;
    let pollingTimer = null;
    let applyingRemote = false;

    const tabs = [
      { id: 'matrix', label: 'Nhập lưới', icon: 'fa-solid fa-table-cells' },
      { id: 'parser', label: 'Dán dữ liệu', icon: 'fa-solid fa-paste' },
      { id: 'catalog', label: 'Danh mục', icon: 'fa-solid fa-book' },
      { id: 'stock', label: 'Tồn kho', icon: 'fa-solid fa-boxes-stacked' },
      { id: 'schools', label: 'Trường học', icon: 'fa-solid fa-school' },
      { id: 'receipts', label: 'Biên bản in', icon: 'fa-solid fa-print' },
      { id: 'debug', label: 'Debug', icon: 'fa-solid fa-terminal' }
    ];

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
      toasts.value.push({ id, message, type });
      setTimeout(() => {
        toasts.value = toasts.value.filter((toast) => toast.id !== id);
      }, 3200);
    }

    function setStatus(mode, origin, banner = '') {
      syncStatus.value = mode;
      dataOrigin.value = origin;
      statusBanner.value = banner;
      lastSyncAt.value = nowText();
    }

    const lastSyncLabel = computed(() => lastSyncAt.value || 'chưa có');

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
      if (!row.schoolQtys) row.schoolQtys = {};
      schools.value.forEach((school) => {
        if (row.schoolQtys[school.id] === undefined) row.schoolQtys[school.id] = 0;
      });
      Object.keys(row.schoolQtys).forEach((key) => {
        if (!schools.value.some((school) => school.id === key)) delete row.schoolQtys[key];
      });
    }

    function recalcRow(row) {
      ensureRowSchools(row);
      const product = products.value.find((item) => norm(item.code) === norm(row.shortcut));
      if (product) {
        row.productName = product.name;
        row.unit = product.unit;
        row.price = num(product.price);
      }
      row.totalQty = round3(schools.value.reduce((sum, school) => sum + num(row.schoolQtys[school.id]), 0));
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

    function openSuggestions(row) {
      row.suggestions = findSuggestions(row.shortcut);
      row.suggestIndex = 0;
      row.showSuggestions = true;
    }

    function closeSuggestions(row) {
      setTimeout(() => { row.showSuggestions = false; }, 120);
    }

    function pickProduct(row, product) {
      row.shortcut = product.code;
      row.productName = product.name;
      row.unit = product.unit;
      row.price = num(product.price);
      row.suggestions = [];
      row.showSuggestions = false;
      recalcRow(row);
      scheduleSync();
    }

    function onShortcutInput(row) {
      row.shortcut = String(row.shortcut || '').trim().toLowerCase();
      row.suggestions = findSuggestions(row.shortcut);
      row.suggestIndex = 0;
      row.showSuggestions = true;
      const exact = products.value.find((product) => norm(product.code) === norm(row.shortcut));
      if (exact) {
        pickProduct(row, exact);
        return;
      }
      row.productName = '';
      row.unit = '';
      row.price = 0;
      recalcRow(row);
      scheduleSync();
    }

    function onShortcutKeydown(event, row) {
      if (!row.suggestions.length) return;
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
        row.showSuggestions = false;
      }
    }

    function addRow() {
      const row = emptyRow();
      schools.value.forEach((school) => { row.schoolQtys[school.id] = 0; });
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

    function rowToOrderRecords(row) {
      if (!norm(row.shortcut)) return [];
      return schools.value.flatMap((school) => {
        const qtyValue = num(row.schoolQtys?.[school.id]);
        return qtyValue > 0 ? [{
          delivery_date: deliveryDate.value,
          product_code: row.shortcut,
          school_id: school.id,
          qty: round3(qtyValue)
        }] : [];
      });
    }

    function ordersToRows(orderRecords) {
      const map = {};
      orderRecords.forEach((order) => {
        const code = norm(order.product_code);
        if (!code) return;
        if (!map[code]) {
          const product = products.value.find((item) => norm(item.code) === code);
          map[code] = emptyRow();
          map[code].shortcut = code;
          if (product) {
            map[code].productName = product.name;
            map[code].unit = product.unit;
            map[code].price = num(product.price);
          }
          schools.value.forEach((school) => { map[code].schoolQtys[school.id] = 0; });
        }
        map[code].schoolQtys[order.school_id] = num(order.qty);
      });
      return Object.values(map).map((row) => {
        recalcRow(row);
        return row;
      });
    }

    function groupOrdersBySchool() {
      const buckets = {};
      schools.value.forEach((school) => { buckets[school.id] = {}; });
      rows.value.forEach((row) => {
        const product = products.value.find((item) => norm(item.code) === norm(row.shortcut));
        if (!product) return;
        schools.value.forEach((school) => {
          const qtyValue = num(row.schoolQtys?.[school.id]);
          if (!qtyValue) return;
          if (!buckets[school.id][product.code]) {
            buckets[school.id][product.code] = {
              code: product.code,
              name: product.name,
              unit: product.unit,
              price: num(product.price),
              qty: 0,
              amount: 0
            };
          }
          buckets[school.id][product.code].qty += qtyValue;
          buckets[school.id][product.code].amount = Math.round(buckets[school.id][product.code].qty * num(product.price));
        });
      });
      return buckets;
    }

    const totalBySchool = computed(() => {
      const totals = {};
      schools.value.forEach((school) => { totals[school.id] = 0; });
      rows.value.forEach((row) => {
        schools.value.forEach((school) => {
          totals[school.id] += num(row.schoolQtys?.[school.id]) * num(row.price);
        });
      });
      return totals;
    });

    const totalSchoolMoney = computed(() => Object.values(totalBySchool.value).reduce((sum, value) => sum + num(value), 0));

    const summaryList = computed(() => {
      const map = {};
      rows.value.forEach((row) => {
        const product = products.value.find((item) => norm(item.code) === norm(row.shortcut));
        if (!product) return;
        if (!map[product.code]) {
          map[product.code] = { code: product.code, name: product.name, unit: product.unit, price: num(product.price), demandQty: 0 };
        }
        map[product.code].demandQty += row.totalQty;
      });
      return Object.values(map)
        .map((item) => {
          const stockQty = num(stockMap.value[item.code]);
          const realBuy = Math.max(0, round3(item.demandQty - stockQty));
          return { ...item, stockQty, realBuy, subTotal: Math.round(realBuy * item.price) };
        })
        .sort((a, b) => norm(a.code).localeCompare(norm(b.code)));
    });

    const totalRealCost = computed(() => summaryList.value.reduce((sum, item) => sum + num(item.subTotal), 0));
    const totalSavedMoney = computed(() => summaryList.value.reduce((sum, item) => sum + Math.round(Math.min(item.demandQty, item.stockQty) * item.price), 0));

    const filteredProducts = computed(() => {
      const q = norm(productFilter.value);
      return !q ? products.value : products.value.filter((item) => norm(item.code).includes(q) || norm(item.name).includes(q));
    });

    const filteredSchools = computed(() => {
      const q = norm(schoolFilter.value);
      return !q ? schools.value : schools.value.filter((item) => norm(item.id).includes(q) || norm(item.name).includes(q));
    });

    const filteredStockProducts = computed(() => {
      const q = norm(stockFilter.value);
      return !q ? products.value : products.value.filter((item) => norm(item.code).includes(q) || norm(item.name).includes(q));
    });

    const receipts = computed(() => {
      const buckets = groupOrdersBySchool();
      return schools.value.map((school) => {
        const items = Object.values(buckets[school.id]).filter((item) => item.qty > 0).sort((a, b) => norm(a.code).localeCompare(norm(b.code)));
        return {
          id: school.id,
          name: school.name,
          theme: school,
          items,
          totalQty: items.reduce((sum, item) => sum + item.qty, 0),
          totalAmount: items.reduce((sum, item) => sum + item.amount, 0)
        };
      });
    });

    function persistLocal() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          schools: schools.value,
          products: products.value,
          stockMap: stockMap.value,
          rows: rows.value,
          deliveryDate: deliveryDate.value
        }));
      } catch (error) {
        logError('persistLocal', error);
      }
    }

    function hydrateLocal() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
          rows.value = [emptyRow()];
          schools.value = clone(defaultSchools);
          products.value = clone(defaultProducts);
          stockMap.value = clone(defaultStock);
          rows.value.forEach((row) => {
            schools.value.forEach((school) => { row.schoolQtys[school.id] = 0; });
          });
          return;
        }
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.schools) && parsed.schools.length) schools.value = parsed.schools;
        if (Array.isArray(parsed.products) && parsed.products.length) products.value = parsed.products;
        if (parsed.stockMap && typeof parsed.stockMap === 'object') stockMap.value = parsed.stockMap;
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
      const response = await fetch(`${API_BASE}${path}`, {
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...options.headers
        },
        ...options
      });
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      if (!response.ok) {
        const detail = typeof data === 'object' && data?.detail ? data.detail : text || `HTTP ${response.status}`;
        throw new Error(detail);
      }
      return data;
    }

    async function fetchSchools() {
      return apiJson('/api/schools');
    }

    async function fetchProducts() {
      return apiJson('/api/products');
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

    async function deleteProductApi(code) {
      return apiJson(`/api/products/${encodeURIComponent(code)}`, { method: 'DELETE' });
    }

    async function saveStockApi(payload) {
      return apiJson('/api/stock/upsert', { method: 'POST', body: JSON.stringify(payload) });
    }

    async function upsertOrderApi(payload) {
      return apiJson('/api/orders/upsert', { method: 'POST', body: JSON.stringify(payload) });
    }

    async function clearOrdersApi(date) {
      return apiJson(`/api/orders?date=${encodeURIComponent(date)}`, { method: 'DELETE' });
    }

    async function pullApiState() {
      try {
        setStatus('Syncing (Polling)', 'API', 'Đang lấy dữ liệu mới từ backend.');
        const [schoolRows, productRows, stockRows, orderRows] = await Promise.all([
          fetchSchools(),
          fetchProducts(),
          fetchStock(),
          fetchOrders(deliveryDate.value)
        ]);

        applyingRemote = true;
        if (schoolRows?.length) schools.value = schoolRows;
        if (productRows?.length) products.value = productRows;
        if (stockRows && typeof stockRows === 'object') stockMap.value = { ...stockRows };
        if (Array.isArray(orderRows) && orderRows.length) rows.value = ordersToRows(orderRows);
        rows.value.forEach((row) => {
          ensureRowSchools(row);
          recalcRow(row);
        });
        parserPreview.value = summaryList.value;
        applyingRemote = false;
        setStatus('Connected (Polling)', 'API', 'Đã đồng bộ dữ liệu qua HTTP polling.');
        persistLocal();
        return true;
      } catch (error) {
        applyingRemote = false;
        logError('pullApiState', error);
        addToast('Không lấy được dữ liệu từ backend', 'error');
        setStatus('Offline', 'Local cache', 'Backend không khả dụng; đang dùng local cache.');
        return false;
      }
    }

    async function pushApiState() {
      const schoolTasks = schools.value.map((school) => saveSchoolApi({
        id: school.id,
        name: school.name,
        bg_color: school.bg_color,
        text_color: school.text_color,
        border_color: school.border_color,
        icon: school.icon
      }));
      const productTasks = products.value.map((product) => saveProductApi({
        code: norm(product.code),
        name: product.name,
        unit: product.unit,
        price: num(product.price)
      }));
      const stockTasks = Object.entries(stockMap.value).map(([product_code, qtyValue]) => saveStockApi({
        product_code: norm(product_code),
        qty: num(qtyValue)
      }));
      const orderTasks = rows.value.flatMap((row) => rowToOrderRecords(row).map((order) => upsertOrderApi(order)));

      await Promise.all([...schoolTasks, ...productTasks, ...stockTasks]);
      await clearOrdersApi(deliveryDate.value);
      await Promise.all(orderTasks);
    }

    async function syncNow() {
      if (syncing) return;
      syncing = true;
      try {
        persistLocal();
        if (!navigator.onLine) {
          setStatus('Offline', 'Local cache', 'Thiết bị offline; giữ dữ liệu local.');
          addToast('Đang offline, dùng dữ liệu local', 'warn');
          return;
        }
        setStatus('Syncing (Polling)', 'API', 'Đang đẩy local lên backend.');
        await pushApiState();
        await pullApiState();
        addToast('Đã đồng bộ với backend', 'success');
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
      if (applyingRemote) return;
      clearTimeout(syncTimer);
      syncTimer = setTimeout(() => {
        if (navigator.onLine) syncNow();
      }, 900);
    }

    function saveProduct() {
      const code = norm(productForm.value.code);
      if (!code || !productForm.value.name.trim()) return;
      const payload = {
        code,
        name: productForm.value.name.trim(),
        unit: productForm.value.unit.trim() || '-',
        price: num(productForm.value.price),
        created_at: today
      };
      const index = products.value.findIndex((product) => norm(product.code) === code);
      if (index >= 0) products.value[index] = payload;
      else products.value.unshift(payload);
      rows.value.forEach((row) => {
        if (norm(row.shortcut) === code) pickProduct(row, payload);
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
      productForm.value = { code: '', name: '', unit: '', price: 0 };
    }

    async function deleteProduct(code) {
      if (!confirm(`Xoá sản phẩm ${code.toUpperCase()}?`)) return;
      products.value = products.value.filter((product) => norm(product.code) !== norm(code));
      delete stockMap.value[code];
      rows.value.forEach((row) => {
        if (norm(row.shortcut) === norm(code)) {
          row.shortcut = '';
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
      const id = norm(schoolForm.value.id);
      if (!id || !schoolForm.value.name.trim()) return;
      const payload = {
        id,
        name: schoolForm.value.name.trim(),
        bg_color: schoolForm.value.bg_color,
        text_color: schoolForm.value.text_color,
        border_color: schoolForm.value.border_color,
        icon: schoolForm.value.icon,
        created_at: today
      };
      const index = schools.value.findIndex((school) => norm(school.id) === id);
      if (index >= 0) schools.value[index] = payload;
      else schools.value.unshift(payload);
      rows.value.forEach((row) => {
        if (!row.schoolQtys[id]) row.schoolQtys[id] = 0;
      });
      resetSchoolForm();
      scheduleSync();
    }

    function editSchool(school) {
      editingSchool.value = true;
      schoolForm.value = clone({ ...school, theme: school.bg_color });
    }

    function resetSchoolForm() {
      editingSchool.value = false;
      schoolForm.value = { id: '', name: '', bg_color: 'bg-sky-50', text_color: 'text-sky-800', border_color: 'border-sky-200', icon: 'fa-school', theme: 'bg-sky-50' };
    }

    async function deleteSchool(id) {
      if (!confirm(`Xoá trường ${id}?`)) return;
      schools.value = schools.value.filter((school) => norm(school.id) !== norm(id));
      rows.value.forEach((row) => {
        if (row.schoolQtys) delete row.schoolQtys[id];
        recalcRow(row);
      });
      try {
        await deleteSchoolApi(id);
        addToast(`Đã xoá trường ${id}`, 'success');
      } catch (error) {
        logError('deleteSchool', error);
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
      stockMap.value = { ...stockMap.value, [code]: num(stockForm.value.qty) };
      stockForm.value = { product_code: '', qty: 0 };
      scheduleSync();
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
          const product = products.value.find((item) => norm(item.code) === code || norm(item.name).includes(code));
          if (!product) return;
          let row = rows.value.find((item) => norm(item.shortcut) === norm(product.code));
          if (!row) {
            row = emptyRow();
            schools.value.forEach((school) => { row.schoolQtys[school.id] = 0; });
            rows.value.push(row);
          }
          pickProduct(row, product);
          const qtys = rest.trim().split(/\s+/).filter(Boolean).map(num);
          schools.value.forEach((school, index) => { row.schoolQtys[school.id] = qtys[index] || 0; });
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
      printSchoolId.value = id;
      nextTick(() => window.print());
    }

    function recalcAllRows() {
      rows.value.forEach((row) => {
        ensureRowSchools(row);
        recalcRow(row);
      });
      parserPreview.value = summaryList.value;
    }

    function loadInitialState() {
      hydrateLocal();
      recalcAllRows();
    }

    function startPollingFallback() {
      stopPollingFallback();
      pollingTimer = setInterval(() => {
        if (navigator.onLine) pullApiState();
      }, 10000);
      setStatus('Connected (Polling)', 'API', 'Đang đồng bộ qua HTTP polling mỗi 10 giây.');
    }

    function stopPollingFallback() {
      if (pollingTimer) {
        clearInterval(pollingTimer);
        pollingTimer = null;
      }
    }

    watch([schools, products, stockMap, rows, deliveryDate], () => {
      if (!applyingRemote) scheduleSync();
    }, { deep: true });

    onMounted(async () => {
      loadInitialState();
      setStatus('Syncing (Polling)', 'API', 'Đang khởi tạo dữ liệu cục bộ.');
      await pullApiState();
      startPollingFallback();
      window.addEventListener('keydown', (event) => {
        if (event.key === 'F2' && currentTab.value === 'matrix') {
          event.preventDefault();
          addRow();
        }
      });
      window.addEventListener('online', () => {
        setStatus('Syncing (Polling)', dataOrigin.value, 'Mạng đã kết nối lại; đang đồng bộ.');
        syncNow();
      });
      window.addEventListener('offline', () => {
        setStatus('Offline', 'Local cache', 'Đang offline; dữ liệu được giữ ở local.');
        addToast('Mất kết nối mạng', 'warn');
      });
      window.addEventListener('afterprint', () => {
        printSchoolId.value = 'all';
      });
    });

    const receiptsComputed = receipts;

    return {
      tabs,
      currentTab,
      deliveryDate,
      rows,
      schools,
      products,
      stockMap,
      parserText,
      parserPreview,
      toasts,
      productFilter,
      schoolFilter,
      stockFilter,
      syncStatus,
      dataOrigin,
      lastSyncLabel,
      statusBanner,
      debugLogs,
      printSchoolId,
      productForm,
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
      addRow,
      removeRow,
      clearRows,
      onShortcutInput,
      onShortcutKeydown,
      openSuggestions,
      closeSuggestions,
      pickProduct,
      recalcRow,
      applyParser,
      fillParserFromClipboard,
      saveProduct,
      editProduct,
      resetProductForm,
      deleteProduct,
      saveSchool,
      editSchool,
      resetSchoolForm,
      deleteSchool,
      addDefaultSchool,
      applySchoolTheme,
      saveStock,
      exportCSV,
      copyDebugLogs,
      syncNow,
      printAllReceipts,
      printSchool
    };
  }
}).mount('#app');
