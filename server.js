const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

require('dotenv').config();

const express = require('express');
const multer = require('multer');
const { MongoClient, GridFSBucket, ObjectId } = require('mongodb');

const app = express();

const config = {
  storeName: process.env.STORE_NAME || 'Farwa Undergarments',
  storeTagline: process.env.STORE_TAGLINE || 'Family-friendly undergarment essentials.',
  storeDescription:
    process.env.STORE_DESCRIPTION ||
    'Farwa Undergarments displays available stock, prices, and quantities for modest everyday essentials in NawabShah.',
  currencySymbol: process.env.CURRENCY_SYMBOL || 'Rs. ',
  contactPrimary: process.env.CONTACT_PRIMARY || '0316-8484140',
  contactSecondary: process.env.CONTACT_SECONDARY || '0306-8581299',
  storeAddress: process.env.STORE_ADDRESS || 'Milli Shopping Mall, Resham Galli, Mohni Bazaar, NawabShah',
  mongoUri: process.env.MONGODB_URI || '',
  mongoDatabase: process.env.MONGODB_DATABASE || 'farwa_undergarments',
  mongoCollection: process.env.MONGODB_COLLECTION || 'items',
  adminUsername: process.env.ADMIN_USERNAME || 'owner',
  adminPassword: process.env.ADMIN_PASSWORD || 'change-this-password',
  sessionSecret: process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || 'farwa-local-secret',
};

const isNetlifyRuntime = Boolean(process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME);
const writableBaseDir = isNetlifyRuntime ? path.join(os.tmpdir(), 'farwa-undergarments') : __dirname;
const publicDir = path.join(__dirname, 'public');
const dataDir = path.join(writableBaseDir, 'data');
const uploadsDir = isNetlifyRuntime ? path.join(writableBaseDir, 'uploads') : path.join(publicDir, 'uploads');
const productsFile = path.join(dataDir, 'products.json');
const maxProductImages = 5;
const defaultTotalUploadMb = process.env.NETLIFY ? 4.3 : 25;
const maxUploadBytes = megabytesToBytes(process.env.MAX_IMAGE_MB || 5);
const maxTotalUploadBytes = megabytesToBytes(process.env.MAX_TOTAL_UPLOAD_MB || defaultTotalUploadMb);
const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

let mongoClientPromise = null;
let lastMongoError = '';

app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false }));
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(publicDir));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxUploadBytes,
    files: maxProductImages,
  },
  fileFilter: (req, file, callback) => {
    if (!allowedImageTypes.has(file.mimetype)) {
      callback(new Error('Use JPG, PNG, or WEBP product pictures.'));
      return;
    }

    callback(null, true);
  },
});

function megabytesToBytes(value) {
  const megabytes = Number.parseFloat(value);
  const safeMegabytes = Number.isFinite(megabytes) && megabytes > 0 ? megabytes : 1;
  return Math.floor(safeMegabytes * 1024 * 1024);
}

function formatUploadSize(bytes) {
  const megabytes = bytes / (1024 * 1024);
  return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)}MB`;
}

function ensureStorage() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });

  if (!fs.existsSync(productsFile)) {
    fs.writeFileSync(productsFile, '[]\n');
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function money(price) {
  const amount = Number(price) || 0;
  const options = Number.isInteger(amount)
    ? { maximumFractionDigits: 0 }
    : { minimumFractionDigits: 2, maximumFractionDigits: 2 };

  return config.currencySymbol + amount.toLocaleString('en-PK', options);
}

function telHref(number) {
  return String(number).replace(/\D/g, '');
}

function productImages(product) {
  const images = Array.isArray(product.images) ? product.images.filter(Boolean) : [];

  if (images.length === 0 && product.image) {
    images.push(product.image);
  }

  if (Array.isArray(product.imageIds)) {
    for (const id of product.imageIds) {
      images.push(`/image/${id}`);
    }
  }

  return [...new Set(images)].slice(0, maxProductImages);
}

function normalizeProduct(product) {
  const images = productImages(product);

  if (!product.id || images.length === 0) {
    return null;
  }

  return {
    id: String(product.id),
    title: String(product.title || product.name || 'Farwa Essential').trim() || 'Farwa Essential',
    images,
    image: images[0],
    price: Math.max(0, Number(product.price) || 0),
    quantity: Math.max(0, Number.parseInt(product.quantity, 10) || 0),
    createdAt: String(product.createdAt || product.created_at || ''),
    imageIds: Array.isArray(product.imageIds) ? product.imageIds.map(String) : [],
  };
}

function sortProducts(products) {
  return products.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function getDb() {
  if (!config.mongoUri) {
    lastMongoError = 'MONGODB_URI is missing.';
    return null;
  }

  if (!mongoClientPromise) {
    mongoClientPromise = MongoClient.connect(config.mongoUri, {
      serverSelectionTimeoutMS: 6000,
    }).catch((error) => {
      mongoClientPromise = null;
      throw error;
    });
  }

  try {
    const client = await mongoClientPromise;
    lastMongoError = '';
    return client.db(config.mongoDatabase);
  } catch (error) {
    lastMongoError = mongoErrorSummary(error);
    return null;
  }
}

function mongoErrorSummary(error) {
  const firstLine = String(error?.message || error || 'Unknown MongoDB error.').split('\n')[0];
  return `${error?.name || 'MongoDBError'}: ${firstLine}`;
}

async function storageInfo() {
  const db = await getDb();
  if (db) {
    return {
      connected: true,
      label: 'MongoDB connected',
      message: '',
    };
  }

  if (isNetlifyRuntime) {
    return {
      connected: false,
      label: 'MongoDB not connected',
      message:
        'Netlify uploads require MongoDB. Check Netlify environment variables and MongoDB Atlas Network Access, then redeploy.',
    };
  }

  return {
    connected: false,
    label: 'Local JSON fallback',
    message: lastMongoError || 'MongoDB is not configured locally.',
  };
}

function readProductsFromJson() {
  ensureStorage();

  try {
    const decoded = JSON.parse(fs.readFileSync(productsFile, 'utf8'));
    if (!Array.isArray(decoded)) {
      return [];
    }

    return sortProducts(decoded.map(normalizeProduct).filter(Boolean));
  } catch (error) {
    return [];
  }
}

function saveProductsToJson(products) {
  ensureStorage();
  fs.writeFileSync(productsFile, JSON.stringify(products, null, 2) + '\n');
}

async function readProductsFromMongo() {
  const db = await getDb();
  if (!db) {
    return null;
  }

  try {
    const products = await db.collection(config.mongoCollection).find({}).sort({ createdAt: -1 }).toArray();
    return sortProducts(products.map(normalizeProduct).filter(Boolean));
  } catch (error) {
    return null;
  }
}

async function readProducts() {
  const mongoProducts = await readProductsFromMongo();
  if (Array.isArray(mongoProducts)) {
    return mongoProducts;
  }

  return isNetlifyRuntime ? [] : readProductsFromJson();
}

function inventoryStats(products) {
  return products.reduce(
    (stats, product) => {
      stats.items += 1;
      stats.quantity += product.quantity;
      stats.value += product.price * product.quantity;
      return stats;
    },
    { items: 0, quantity: 0, value: 0 }
  );
}

function normalizeTitle(value) {
  const title = String(value || '').trim();

  if (!title) {
    throw new Error('Enter the item name.');
  }

  if (title.length > 120) {
    throw new Error('Item name must be 120 characters or shorter.');
  }

  return title;
}

function normalizePrice(value) {
  const price = Number(String(value || '').replaceAll(',', '').trim());

  if (!Number.isFinite(price) || price < 0) {
    throw new Error('Enter a valid price.');
  }

  return Math.round(price * 100) / 100;
}

function normalizeQuantity(value) {
  const quantity = Number.parseInt(value, 10);

  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new Error('Enter a valid quantity.');
  }

  return quantity;
}

function validateUploadFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('Upload at least one product picture.');
  }

  if (files.length > maxProductImages) {
    throw new Error('Upload no more than 5 pictures for one item.');
  }

  const totalBytes = files.reduce((sum, file) => sum + Number(file.size || file.buffer?.length || 0), 0);
  if (totalBytes > maxTotalUploadBytes) {
    throw new Error(`Keep all pictures under ${formatUploadSize(maxTotalUploadBytes)} total.`);
  }
}

async function saveImages(files, productId) {
  validateUploadFiles(files);
  const db = await getDb();

  if (db) {
    const bucket = new GridFSBucket(db, { bucketName: 'item_images' });
    const imageIds = [];

    for (const file of files) {
      const id = new ObjectId();
      await new Promise((resolve, reject) => {
        const uploadStream = bucket.openUploadStreamWithId(id, `${productId}-${file.originalname}`, {
          contentType: file.mimetype,
          metadata: {
            productId,
            originalName: file.originalname,
          },
        });
        Readable.from(file.buffer).pipe(uploadStream).on('error', reject).on('finish', resolve);
      });
      imageIds.push(id.toString());
    }

    return {
      imageIds,
      images: imageIds.map((id) => `/image/${id}`),
    };
  }

  if (isNetlifyRuntime) {
    throw new Error('MongoDB is not connected. Check Netlify environment variables and MongoDB Atlas Network Access.');
  }

  ensureStorage();
  const images = [];

  for (const file of files) {
    const extension = file.mimetype === 'image/png' ? 'png' : file.mimetype === 'image/webp' ? 'webp' : 'jpg';
    const filename = `item-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${extension}`;
    fs.writeFileSync(path.join(uploadsDir, filename), file.buffer);
    images.push(`uploads/${filename}`);
  }

  return {
    imageIds: [],
    images,
  };
}

async function createProduct(body, files) {
  const title = normalizeTitle(body.title);
  const price = normalizePrice(body.price);
  const quantity = normalizeQuantity(body.quantity);
  const productId = `item_${crypto.randomBytes(8).toString('hex')}`;
  const savedImages = await saveImages(files, productId);
  const product = {
    id: productId,
    title,
    images: savedImages.images,
    imageIds: savedImages.imageIds,
    price,
    quantity,
    createdAt: new Date().toISOString(),
  };

  const db = await getDb();
  if (db) {
    await db.collection(config.mongoCollection).insertOne(product);
    return;
  }

  const products = readProductsFromJson();
  products.push(product);
  saveProductsToJson(products);
}

async function updateProduct(id, body) {
  const updates = {
    title: normalizeTitle(body.title),
    price: normalizePrice(body.price),
    quantity: normalizeQuantity(body.quantity),
  };

  const db = await getDb();
  if (db) {
    const result = await db.collection(config.mongoCollection).updateOne({ id }, { $set: updates });
    if (result.matchedCount > 0) {
      return;
    }
  }

  const products = readProductsFromJson();
  const index = products.findIndex((product) => product.id === id);

  if (index === -1) {
    throw new Error('That item was not found.');
  }

  products[index] = { ...products[index], ...updates };
  saveProductsToJson(products);
}

async function deleteGridFsImages(db, imageIds) {
  if (!db || !Array.isArray(imageIds)) {
    return;
  }

  const bucket = new GridFSBucket(db, { bucketName: 'item_images' });

  for (const id of imageIds) {
    if (!ObjectId.isValid(id)) {
      continue;
    }

    try {
      await bucket.delete(new ObjectId(id));
    } catch (error) {
      // Ignore missing files so deleting an item still succeeds.
    }
  }
}

function deleteLocalImages(images) {
  for (const image of images || []) {
    const cleanImage = String(image).replaceAll('\\', '/');

    if (!cleanImage.startsWith('uploads/') || cleanImage.includes('..')) {
      continue;
    }

    const fullPath = path.resolve(publicDir, cleanImage);

    if (fullPath.startsWith(uploadsDir) && fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }
  }
}

async function deleteProduct(id) {
  const db = await getDb();

  if (db) {
    const product = await db.collection(config.mongoCollection).findOne({ id });
    const result = await db.collection(config.mongoCollection).deleteOne({ id });

    if (result.deletedCount > 0) {
      await deleteGridFsImages(db, product?.imageIds || []);
      deleteLocalImages(product?.images || []);
      return;
    }
  }

  const products = readProductsFromJson();
  const product = products.find((item) => item.id === id);
  const remaining = products.filter((item) => item.id !== id);

  if (!product) {
    throw new Error('That item was not found.');
  }

  saveProductsToJson(remaining);
  deleteLocalImages(product.images || []);
}

function signAdminCookie() {
  return crypto.createHmac('sha256', config.sessionSecret).update('admin').digest('hex');
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map((cookie) => cookie.trim())
      .filter(Boolean)
      .map((cookie) => {
        const [key, ...parts] = cookie.split('=');
        return [decodeURIComponent(key), decodeURIComponent(parts.join('='))];
      })
  );
}

function isAuthenticated(req) {
  return parseCookies(req).farwa_admin === signAdminCookie();
}

function requireAdmin(req, res, next) {
  if (!isAuthenticated(req)) {
    res.redirect('/admin');
    return;
  }

  next();
}

function setAdminCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `farwa_admin=${encodeURIComponent(signAdminCookie())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`
  );
}

function clearAdminCookie(res) {
  res.setHeader('Set-Cookie', 'farwa_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function pageLayout({ title, description = config.storeDescription, body, active = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeAttr(description)}">
  <link rel="stylesheet" href="/assets/css/styles.css">
</head>
<body class="storefront-page">
  <header class="site-header">
    <a class="brand" href="/" aria-label="${escapeAttr(config.storeName)} home">
      <span class="brand-mark">FU</span>
      <span>
        <strong>${escapeHtml(config.storeName)}</strong>
        <small>${escapeHtml(config.storeTagline)}</small>
      </span>
    </a>
    <nav class="header-actions" aria-label="Main navigation">
      <a href="/#stock"${active === 'stock' ? ' aria-current="page"' : ''}>Stock</a>
      <a href="/contact"${active === 'contact' ? ' aria-current="page"' : ''}>Contact</a>
    </nav>
  </header>
  ${body}
</body>
</html>`;
}

function footerHtml() {
  return `<footer class="site-footer">
    <strong>${escapeHtml(config.storeName)}</strong>
    <span>${escapeHtml(config.storeAddress)}</span>
  </footer>`;
}

function galleryViewerHtml() {
  return `<div class="image-viewer" id="imageViewer" role="dialog" aria-modal="true" aria-hidden="true" aria-labelledby="viewerTitle">
    <div class="image-viewer-backdrop" data-viewer-close></div>
    <div class="image-viewer-panel">
      <div class="image-viewer-header">
        <div>
          <p class="eyebrow">Item pictures</p>
          <h2 id="viewerTitle">Product image</h2>
          <span id="viewerCounter"></span>
        </div>
        <button class="viewer-close" type="button" data-viewer-close aria-label="Close picture viewer"><span aria-hidden="true">&times;</span></button>
      </div>
      <div class="image-viewer-stage">
        <button class="viewer-nav viewer-prev" type="button" id="viewerPrev" aria-label="Previous picture"><span aria-hidden="true">&#8592;</span></button>
        <img id="viewerImage" src="" alt="">
        <button class="viewer-nav viewer-next" type="button" id="viewerNext" aria-label="Next picture"><span aria-hidden="true">&#8594;</span></button>
      </div>
    </div>
  </div>
  <script src="/assets/js/gallery.js"></script>`;
}

function productCardHtml(product) {
  const images = product.images.slice(0, maxProductImages);
  const galleryImages = escapeAttr(JSON.stringify(images));
  const inStock = product.quantity > 0;

  return `<article class="product-card">
    <div class="product-gallery">
      <button class="product-media gallery-trigger" type="button" data-gallery-images="${galleryImages}" data-gallery-index="0" data-gallery-title="${escapeAttr(product.title)}" aria-label="View ${escapeAttr(product.title)} picture 1">
        <img src="${escapeAttr(images[0])}" alt="${escapeAttr(product.title)}">
        <span class="media-open-icon" aria-hidden="true"></span>
      </button>
      ${
        images.length > 1
          ? `<div class="product-thumbnails" aria-label="${escapeAttr(product.title)} photos">
              ${images
                .map(
                  (image, index) => `<button class="thumbnail-button gallery-trigger" type="button" data-gallery-images="${galleryImages}" data-gallery-index="${index}" data-gallery-title="${escapeAttr(product.title)}" aria-label="View ${escapeAttr(product.title)} picture ${index + 1}">
                    <img src="${escapeAttr(image)}" alt="${escapeAttr(product.title)} photo ${index + 1}">
                  </button>`
                )
                .join('')}
            </div>`
          : ''
      }
    </div>
    <div class="product-meta">
      <div>
        <p class="product-type">Farwa stock item</p>
        <h3>${escapeHtml(product.title)}</h3>
      </div>
      <strong class="product-price">${escapeHtml(money(product.price))}</strong>
    </div>
    <div class="availability-row">
      <span class="stock-label ${inStock ? 'in-stock' : 'sold-out'}">${inStock ? `${product.quantity} in stock` : 'Out of stock'}</span>
      <a class="text-link" href="/contact">Ask about item</a>
    </div>
  </article>`;
}

function emptyStoreHtml() {
  return `<div class="empty-store">
    <div>
      <p class="eyebrow">Stock update</p>
      <h3>No items uploaded yet.</h3>
      <p>Items will appear here after the owner uploads product photos, name, price, and quantity.</p>
    </div>
  </div>`;
}

async function homePageHtml() {
  const products = await readProducts();
  const stats = inventoryStats(products);

  return pageLayout({
    title: `${config.storeName} | Available Stock`,
    active: 'stock',
    body: `<main>
      <section class="hero">
        <div class="hero-content">
          <p class="eyebrow">Available now in NawabShah</p>
          <h1>Farwa Undergarments stock catalogue.</h1>
          <p>A clean, modest display of available undergarment items with item pictures, price, quantity, and current stock details.</p>
          <div class="hero-actions">
            <a class="button primary-button" href="#stock">View available items</a>
            <a class="button secondary-button" href="/contact">Contact shop</a>
          </div>
        </div>
        <figure class="hero-visual">
          <img src="/assets/images/hero-basics.png" alt="Folded cotton essentials with simple packaging">
          <figcaption>
            <strong>${stats.quantity}</strong>
            <span>pieces listed</span>
          </figcaption>
        </figure>
      </section>
      <section class="trust-bar" aria-label="Store information">
        <div>
          <strong>${stats.items} Items</strong>
          <span>Uploaded by the shop owner.</span>
        </div>
        <div>
          <strong>${stats.quantity} Pieces</strong>
          <span>Total quantity currently listed.</span>
        </div>
        <div>
          <strong>Visit or Call</strong>
          <span>${escapeHtml(config.contactPrimary)} / ${escapeHtml(config.contactSecondary)}</span>
        </div>
      </section>
      <section class="collection-section" id="stock">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Current stock</p>
            <h2>Available Items</h2>
          </div>
          <span>${stats.items} item${stats.items === 1 ? '' : 's'} listed</span>
        </div>
        ${products.length === 0 ? emptyStoreHtml() : `<div class="product-grid">${products.map(productCardHtml).join('')}</div>`}
      </section>
      <section class="detail-band">
        <div class="detail-copy">
          <p class="eyebrow">Shop details</p>
          <h2>Simple catalogue for customers before they call or visit.</h2>
          <p>The owner can upload the item name, up to five pictures, price, and quantity from the admin page. Customers see only availability details.</p>
        </div>
        <div class="detail-grid">
          <article><span>01</span><h3>Multiple Photos</h3><p>Each item can show up to five pictures for better product clarity.</p></article>
          <article><span>02</span><h3>Clear Price</h3><p>Prices are displayed plainly in rupees for quick customer review.</p></article>
          <article><span>03</span><h3>Quantity Listed</h3><p>Customers can see how many pieces are available before contacting.</p></article>
        </div>
      </section>
    </main>
    ${footerHtml()}
    ${galleryViewerHtml()}`,
  });
}

function contactPageHtml() {
  return pageLayout({
    title: `Contact | ${config.storeName}`,
    active: 'contact',
    body: `<main>
      <section class="contact-hero">
        <div>
          <p class="eyebrow">Contact us</p>
          <h1>Call or visit Farwa Undergarments.</h1>
          <p>Ask about item availability, prices, and quantities before visiting the shop.</p>
        </div>
      </section>
      <section class="contact-grid" aria-label="Farwa Undergarments contact details">
        <article>
          <span>Primary number</span>
          <a href="tel:${escapeAttr(telHref(config.contactPrimary))}">${escapeHtml(config.contactPrimary)}</a>
        </article>
        <article>
          <span>Second number</span>
          <a href="tel:${escapeAttr(telHref(config.contactSecondary))}">${escapeHtml(config.contactSecondary)}</a>
        </article>
        <article class="address-card">
          <span>Address</span>
          <strong>${escapeHtml(config.storeAddress)}</strong>
        </article>
      </section>
    </main>
    ${footerHtml()}`,
  });
}

function adminLayout({ title = 'Owner Admin', body }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} | ${escapeHtml(config.storeName)}</title>
  <meta name="description" content="Owner inventory admin for ${escapeAttr(config.storeName)}">
  <link rel="stylesheet" href="/assets/css/styles.css">
</head>
<body class="admin-page">
  <header class="site-header admin-header">
    <a class="brand" href="/" aria-label="${escapeAttr(config.storeName)} storefront">
      <span class="brand-mark">FU</span>
      <span>
        <strong>${escapeHtml(config.storeName)}</strong>
        <small>Owner inventory</small>
      </span>
    </a>
    <nav class="header-actions" aria-label="Admin navigation">
      <a href="/">View store</a>
      <a href="/contact">Contact page</a>
      <a href="/logout">Sign out</a>
    </nav>
  </header>
  ${body}
</body>
</html>`;
}

function loginPageHtml(error = '') {
  return adminLayout({
    title: 'Owner Admin',
    body: `<main>
      <section class="login-screen">
        <div class="login-panel">
          <p class="eyebrow">Owner access</p>
          <h1>Sign in to manage inventory</h1>
          <p>Upload item name, up to five pictures, price, and quantity.</p>
          ${error ? `<div class="alert error-alert">${escapeHtml(error)}</div>` : ''}
          <form class="admin-form" method="post" action="/admin/login">
            <label>Username <input type="text" name="username" autocomplete="username" required></label>
            <label>Password <input type="password" name="password" autocomplete="current-password" required></label>
            <button class="button primary-button" type="submit">Sign in</button>
          </form>
        </div>
      </section>
    </main>`,
  });
}

async function adminPageHtml({ error = '', flash = '' } = {}) {
  const products = await readProducts();
  const stats = inventoryStats(products);
  const storage = await storageInfo();
  const storageWarning = storage.connected ? '' : storage.message;

  return adminLayout({
    title: 'Owner Admin',
    body: `<main>
      <section class="admin-shell">
        <div class="admin-title-row">
          <div>
            <p class="eyebrow">Admin</p>
            <h1>Inventory dashboard</h1>
          </div>
          <span class="storage-pill ${storage.connected ? 'connected-pill' : 'warning-pill'}">${escapeHtml(storage.label)}</span>
        </div>
        ${flash ? `<div class="alert success-alert">${escapeHtml(flash)}</div>` : ''}
        ${error ? `<div class="alert error-alert">${escapeHtml(error)}</div>` : ''}
        ${storageWarning ? `<div class="alert error-alert">${escapeHtml(storageWarning)}</div>` : ''}
        <div class="stat-grid" aria-label="Inventory summary">
          <article class="stat-card"><span>Items</span><strong>${stats.items}</strong></article>
          <article class="stat-card"><span>Pieces</span><strong>${stats.quantity}</strong></article>
          <article class="stat-card"><span>Stock value</span><strong>${escapeHtml(money(stats.value))}</strong></article>
        </div>
        <section class="admin-grid">
          <article class="upload-panel">
            <div class="panel-heading">
              <p class="eyebrow">New item</p>
              <h2>Upload product</h2>
            </div>
            <form class="admin-form" method="post" action="/admin/items" enctype="multipart/form-data">
              <label>Item name <input type="text" name="title" maxlength="120" placeholder="Cotton vest pack" required></label>
              <label>Item pictures <input type="file" name="images" accept="image/jpeg,image/png,image/webp" multiple required><small>1 to 5 JPG, PNG, or WEBP pictures. ${escapeHtml(formatUploadSize(maxTotalUploadBytes))} total limit.</small></label>
              <div class="form-row">
                <label>Price <input type="number" name="price" min="0" step="1" placeholder="1200" required></label>
                <label>Quantity <input type="number" name="quantity" min="0" step="1" placeholder="25" required></label>
              </div>
              <button class="button primary-button" type="submit">Upload item</button>
            </form>
          </article>
          <section class="inventory-panel" aria-labelledby="inventoryTitle">
            <div class="panel-heading">
              <p class="eyebrow">Live items</p>
              <h2 id="inventoryTitle">Name, price, quantity</h2>
            </div>
            ${
              products.length === 0
                ? '<div class="empty-inventory"><h3>No items yet</h3><p>Upload the first product with its name, pictures, price, and quantity.</p></div>'
                : `<div class="inventory-list">${products.map(inventoryItemHtml).join('')}</div>`
            }
          </section>
        </section>
      </section>
    </main>`,
  });
}

function inventoryItemHtml(product) {
  return `<article class="inventory-item">
    <img src="${escapeAttr(product.image)}" alt="${escapeAttr(product.title)}">
    <div class="inventory-details">
      <h3>${escapeHtml(product.title)}</h3>
      <p>${product.images.length} photo${product.images.length === 1 ? '' : 's'} uploaded</p>
      <form class="inventory-form" method="post" action="/admin/items/${escapeAttr(product.id)}/update">
        <label>Name <input type="text" name="title" maxlength="120" value="${escapeAttr(product.title)}" required></label>
        <label>Price <input type="number" name="price" min="0" step="1" value="${escapeAttr(Math.round(product.price))}" required></label>
        <label>Quantity <input type="number" name="quantity" min="0" step="1" value="${escapeAttr(product.quantity)}" required></label>
        <button class="button compact-button" type="submit">Save</button>
      </form>
    </div>
    <form class="delete-form" method="post" action="/admin/items/${escapeAttr(product.id)}/delete" onsubmit="return confirm('Delete this item?');">
      <button class="button danger-button" type="submit">Delete</button>
    </form>
  </article>`;
}

function redirectWithMessage(res, pathValue, message) {
  const separator = pathValue.includes('?') ? '&' : '?';
  res.redirect(`${pathValue}${separator}message=${encodeURIComponent(message)}`);
}

function uploadErrorMessage(error) {
  if (!error) {
    return 'Item could not be uploaded.';
  }

  if (error.code === 'LIMIT_FILE_SIZE') {
    return `Each picture must be ${formatUploadSize(maxUploadBytes)} or smaller.`;
  }

  if (error.code === 'LIMIT_FILE_COUNT') {
    return 'Upload no more than 5 pictures for one item.';
  }

  return error.message || 'Item could not be uploaded.';
}

function handleProductUpload(req, res, next) {
  upload.array('images', maxProductImages)(req, res, (error) => {
    if (error) {
      res.redirect('/admin?error=' + encodeURIComponent(uploadErrorMessage(error)));
      return;
    }

    next();
  });
}

app.get('/', async (req, res, next) => {
  try {
    res.send(await homePageHtml());
  } catch (error) {
    next(error);
  }
});

app.get('/contact', (req, res) => {
  res.send(contactPageHtml());
});

app.get('/admin', async (req, res, next) => {
  try {
    if (!isAuthenticated(req)) {
      res.send(loginPageHtml(req.query.error || ''));
      return;
    }

    res.send(await adminPageHtml({ flash: req.query.message || '', error: req.query.error || '' }));
  } catch (error) {
    next(error);
  }
});

app.post('/admin/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');

  if (safeEqual(username, config.adminUsername) && safeEqual(password, config.adminPassword)) {
    setAdminCookie(res);
    res.redirect('/admin');
    return;
  }

  res.redirect('/admin?error=' + encodeURIComponent('The owner username or password is incorrect.'));
});

app.get('/logout', (req, res) => {
  clearAdminCookie(res);
  res.redirect('/admin');
});

app.post('/admin/items', requireAdmin, handleProductUpload, async (req, res) => {
  try {
    await createProduct(req.body, req.files || []);
    redirectWithMessage(res, '/admin', 'Item uploaded successfully.');
  } catch (error) {
    res.redirect('/admin?error=' + encodeURIComponent(error.message || 'Item could not be uploaded.'));
  }
});

app.post('/admin/items/:id/update', requireAdmin, async (req, res) => {
  try {
    await updateProduct(req.params.id, req.body);
    redirectWithMessage(res, '/admin', 'Item updated successfully.');
  } catch (error) {
    res.redirect('/admin?error=' + encodeURIComponent(error.message || 'Item could not be updated.'));
  }
});

app.post('/admin/items/:id/delete', requireAdmin, async (req, res) => {
  try {
    await deleteProduct(req.params.id);
    redirectWithMessage(res, '/admin', 'Item deleted successfully.');
  } catch (error) {
    res.redirect('/admin?error=' + encodeURIComponent(error.message || 'Item could not be deleted.'));
  }
});

app.get('/image/:id', async (req, res, next) => {
  const db = await getDb();

  if (!db || !ObjectId.isValid(req.params.id)) {
    next();
    return;
  }

  try {
    const bucket = new GridFSBucket(db, { bucketName: 'item_images' });
    const files = await bucket.find({ _id: new ObjectId(req.params.id) }).toArray();

    if (files.length === 0) {
      next();
      return;
    }

    res.setHeader('Content-Type', files[0].contentType || 'application/octet-stream');
    bucket.openDownloadStream(new ObjectId(req.params.id)).pipe(res);
  } catch (error) {
    next(error);
  }
});

app.use((req, res) => {
  res.status(404).send(
    pageLayout({
      title: `Page not found | ${config.storeName}`,
      body: `<main><section class="empty-store"><div><p class="eyebrow">404</p><h3>Page not found.</h3><p>The page you requested does not exist.</p><div class="hero-actions"><a class="button primary-button" href="/">Back to store</a></div></div></section></main>${footerHtml()}`,
    })
  );
});

app.use((error, req, res, next) => {
  res.status(500).send(
    pageLayout({
      title: `Something went wrong | ${config.storeName}`,
      body: `<main><section class="empty-store"><div><p class="eyebrow">Error</p><h3>Something went wrong.</h3><p>${escapeHtml(error.message || 'Please try again.')}</p><div class="hero-actions"><a class="button primary-button" href="/">Back to store</a></div></div></section></main>${footerHtml()}`,
    })
  );
});

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    console.log(`Farwa Undergarments running on http://localhost:${port}`);
  });
}

module.exports = app;
