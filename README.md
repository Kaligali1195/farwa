# Farwa Undergarments

A professional stock catalogue for Farwa Undergarments built with HTML, CSS, and a Node.js/Express server.

## What is included

- Clean Shopify-inspired storefront layout
- Product grid with item name, price, quantity, and up to 5 photos
- Clickable photo viewer with next/previous controls
- Contact page with shop phone numbers and address
- Owner-only admin page at `/admin`
- Admin upload form for item name, pictures, price, and quantity
- MongoDB inventory storage with GridFS image storage
- Local JSON and upload fallback when MongoDB is not configured
- Netlify Functions wrapper for Netlify deployment
- Dockerfile and `render.yaml` for Render deployment

## Run locally

Install Node.js 18 or newer, then run:

```powershell
npm install
npm start
```

Open:

```text
http://localhost:3000
```

Admin page:

```text
http://localhost:3000/admin
```

## Environment variables

Create a local `.env` file from `.env.example` and set real values:

```text
MONGODB_URI
MONGODB_DATABASE
MONGODB_COLLECTION
ADMIN_USERNAME
ADMIN_PASSWORD
SESSION_SECRET
MAX_IMAGE_MB
MAX_TOTAL_UPLOAD_MB
```

If `MONGODB_URI` is missing or the database cannot be reached, the site still runs using `data/products.json` and `public/uploads`.

## Deploy on Netlify

1. Push this folder to a GitHub repository.
2. In Netlify, choose **Add new site** then **Import an existing project**.
3. Select the repository.
4. Keep the build command empty unless Netlify asks for one.
5. Use `public` as the publish directory.
6. Netlify will use `netlify/functions/server.js` for the Node server routes.
7. Add these environment variables in Netlify:

```text
MONGODB_URI
MONGODB_DATABASE=farwa_undergarments
MONGODB_COLLECTION=items
ADMIN_USERNAME=owner
ADMIN_PASSWORD=your-secure-admin-password
SESSION_SECRET=your-long-random-session-secret
MAX_IMAGE_MB=2
MAX_TOTAL_UPLOAD_MB=4.3
STORE_NAME=Farwa Undergarments
CONTACT_PRIMARY=0316-8484140
CONTACT_SECONDARY=0306-8581299
STORE_ADDRESS=Milli Shopping Mall, Resham Galli, Mohni Bazaar, NawabShah
```

Important: Netlify Functions cannot permanently store uploaded files on disk. Use MongoDB so item photos are saved in GridFS and stay available after deploys.
Keep Netlify upload sizes small; the whole request body must fit within Netlify's function request limit.

If Netlify shows a file-system error like `mkdir '/var/task/netlify/functions/data'`, redeploy the latest code and confirm `MONGODB_URI` is set in **Site configuration > Environment variables**. The app now avoids writing inside Netlify's read-only function folder, but MongoDB is still required for permanent deployed inventory and images.

## Deploy on Render

Render can use the included Dockerfile and `render.yaml`.

Set these environment variables on Render:

```text
MONGODB_URI
ADMIN_PASSWORD
SESSION_SECRET
MAX_IMAGE_MB=5
MAX_TOTAL_UPLOAD_MB=25
```

The included disk mount is only a fallback for local-file uploads. MongoDB is recommended for production image storage.
