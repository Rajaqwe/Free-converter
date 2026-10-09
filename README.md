# PDF + AI + CDR → PLT Batch Cutter v18

A public web application to preview, select, and convert **PDF**, **Adobe Illustrator (AI)**, and **CorelDRAW (CDR)** artwork into **HPGL `.PLT`** cutter files individually or as a batch ZIP. The hosted CDR route uses Inkscape/libcdr where compatible. Distinct outline colours are mapped to separate HPGL pen selections for cutline/bleed workflows.

- **Frontend**: Static Web Application hosted on **GitHub Pages**
- **Backend**: Docker Web Service running **Node.js + Express**
- **Conversion Pipeline**: **Ghostscript + pstoedit** generating genuine HPGL plot files

---

## Architecture

```text
Public user
    ↓
GitHub Pages frontend
    ↓ HTTPS API request
Node.js + Express backend
    ├── PDF: use uploaded PDF
    ├── AI: Ghostscript / Inkscape normalisation
    └── CDR: Inkscape + libcdr → PDF
    ↓
Ghostscript (ps2write) → PostScript
    ↓
pstoedit HPGL driver (separate pen IDs for distinct outline colours)
    ↓
HPGL (.PLT)
```



1. **Upload**: User uploads `.pdf`, `.ai` or `.cdr` via drag-and-drop or file picker.
2. **Intermediate PostScript**: The backend uses Ghostscript (`-sDEVICE=ps2write`) to extract vector paths from each selected page.
3. **Vector Extraction**: `pstoedit` translates PostScript paths into HPGL commands (`PU`, `PD`) and maps distinct source outline colours to separate pen selections (`SP1`, `SP2`, etc.), up to the configured pen-colour limit.
4. **Verification**: Lightweight analysis checks vector/raster content without generating full PLT output for every page. Actual PLT generation verifies the drawing commands.
5. **Download**: Converted files are offered as individual `.PLT` files or packaged into a batch `.ZIP`.

---

## Project Structure

```text
Free-converter/
├── index.html              # PDF + AI + CDR batch cutter UI & client logic
├── config.js               # Configurable backend API base URL
├── assets/
│   └── pdfjs/              # Vendored PDF.js library & web worker
├── .nojekyll               # Disables Jekyll processing on GitHub Pages
├── .github/
│   └── workflows/
│       └── pages.yml       # GitHub Pages automated deployment workflow
├── backend/
│   ├── server.js           # Production Express converter API
│   ├── package.json        # Backend dependencies (express, archiver)
│   ├── Dockerfile          # Linux Dockerfile with Ghostscript, pstoedit & Inkscape
│   ├── .dockerignore       # Build exclusion rules
│   ├── .env.example        # Environment variable templates
│   ├── health.html         # API landing and status page
│   └── README.md           # Backend service documentation
└── README.md               # Project documentation
```

---

## Local Development

### 1. Run the Backend Locally

#### Prerequisites
- Node.js 18+
- [Ghostscript](https://www.ghostscript.com/)
- [pstoedit](http://www.pstoedit.net/)
- [Inkscape](https://inkscape.org/) with CDR/libcdr input support (for hosted CDR import and AI fallback)

```bash
cd backend
npm install
npm start
```
The backend server runs on `http://127.0.0.1:10000` (or the port specified in `PORT`).

### 2. Run the Frontend Locally

Serve the repository root using any static web server:
```bash
npx serve .
```
Visit `http://localhost:3000`. The frontend will detect local development and automatically route API requests to `http://127.0.0.1:10000`.

---

## Docker Build & Run

You can build and run the backend locally using Docker:

```bash
cd backend

# Build Docker image
docker build -t pdf-to-plt-backend .

# Run Docker container
docker run -d -p 10000:10000 -e PORT=10000 -e ALLOWED_ORIGINS=* pdf-to-plt-backend
```

Check backend health:
```bash
curl http://localhost:10000/api/health
```

---

## Deploying the Backend to Render

1. Log into [Render Dashboard](https://dashboard.render.com).
2. Click **New +** -> **Web Service**.
3. Select your repository: `Rajaqwe/Free-converter`.
4. Configure service parameters:
   - **Name**: `pdf-to-plt-backend`
   - **Environment / Runtime**: `Docker`
   - **Root Directory**: `backend`
   - **Instance Type**: Free or Starter
   - For predictable first-request latency, use an always-on plan. Free services may spin down after inactivity; code changes alone cannot remove that host-level cold start.
5. Environment Variables:
   - `PORT`: `10000`
   - `ALLOWED_ORIGINS`: `https://rajaqwe.github.io`
   - `MAX_FILE_SIZE_MB`: `50`
6. Click **Create Web Service**.
7. Once deployed, copy your Render URL (e.g. `https://pdf-to-plt-backend.onrender.com`).
8. Update `config.js` with your Render URL or set `window.PLT_API_BASE_URL`.

---

## Deploying the Frontend to GitHub Pages

1. In the GitHub repository settings (`https://github.com/Rajaqwe/Free-converter/settings/pages`):
   - Under **Build and deployment** -> **Source**, select **GitHub Actions**.
2. Commit and push any changes to `main`.
3. The GitHub Actions workflow in `.github/workflows/pages.yml` will automatically build and publish the site to:
   ```text
   https://rajaqwe.github.io/Free-converter/
   ```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `10000` | Port for the HTTP server to bind to |
| `HOST` | `0.0.0.0` | Network interface to bind to |
| `ALLOWED_ORIGINS` | `https://rajaqwe.github.io` | Comma-separated list of allowed CORS origins or `*` |
| `MAX_FILE_SIZE_MB` | `50` | Maximum upload file size in megabytes |
| `HPGL_MAX_PEN_COLORS` | `16` | Maximum distinct source outline colours mapped to HPGL pen numbers (2–256) |
| `TEMP_DIR` | system temp | Working directory for temporary conversion files |

---

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | API status and overview |
| `GET` | `/api/ping` | Lightweight ping endpoint |
| `GET` | `/api/health` | Comprehensive engine diagnostics (Ghostscript + pstoedit) |
| `POST` | `/api/source` | Upload PDF, AI or CDR file for vector processing |
| `GET` | `/api/source/:id/pdf` | Retrieve normalized preview PDF |
| `GET` | `/api/source/:id/analyze/:page` | Analyze page for cuttable vectors & raster blocking |
| `GET` | `/api/source/:id/plt/:page` | Convert single page to HPGL PLT |
| `GET` | `/api/file/:id/:name` | Download converted PLT |
| `POST` | `/api/batch-zip` | Batch-convert multiple pages into a ZIP |
| `GET` | `/api/zip/:id` | Download generated batch ZIP |

---

## Troubleshooting

- **"Converter offline" in status bar**:
  Free-tier instances on hosts like Render sleep after inactivity. It can take ~30-45 seconds for the instance to wake up on the first request. The frontend includes automatic polling and retries.
- **CORS Error**:
  Ensure the backend has `ALLOWED_ORIGINS` configured to include `https://rajaqwe.github.io` or `*`.
- **"No cuttable vector paths found"**:
  PLT files require vector linework. Bitmaps, raster images, and unstroked shapes without vector paths cannot produce HPGL plot commands.

- **CDR import failures**: Inkscape/libcdr does not guarantee identical support for every CDR version or CorelDRAW effect. Re-save the file in CorelDRAW 2022 or export a vector PDF as a fallback.
- **Colour separation**: HPGL pen IDs preserve separate colour groups, but the receiving plotter/software determines each pen's displayed or physical colour.
