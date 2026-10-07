# PDF + AI → PLT Conversion Backend

Production Docker Web Service powering the vector conversion pipeline for [PDF-to-PLT Batch v17](https://rajaqwe.github.io/Free-converter/).

## Architecture & Conversion Pipeline

```text
PDF / AI File Upload
        │
        ▼
   Ghostscript (ps2write)
        │
        ▼
Intermediate PostScript (.ps)
        │
        ▼
  pstoedit (-f hpgl)
        │
        ▼
  Real HPGL (.PLT)
```

## Running with Docker

### Build the image
```bash
docker build -t pdf-to-plt-backend .
```

### Run the container
```bash
docker run -p 10000:10000 -e PORT=10000 pdf-to-plt-backend
```

Service will be accessible at `http://localhost:10000`.

## Deployment to Render.com

1. In Render Dashboard, click **New +** -> **Web Service**.
2. Connect your repository: `Rajaqwe/Free-converter`.
3. Set configuration:
   - **Environment / Runtime**: `Docker`
   - **Root Directory**: `backend`
   - **Dockerfile Path**: `Dockerfile` (or leave default relative to Root Directory)
   - **Instance Type**: Free or Starter
4. Environment Variables:
   - `PORT`: `10000` (Render sets this automatically)
   - `ALLOWED_ORIGINS`: `https://rajaqwe.github.io`
   - `MAX_FILE_SIZE_MB`: `50`
5. Click **Create Web Service**.

## API Endpoints

- `GET /` — API service info
- `GET /api/ping` — Lightweight keep-alive / ping
- `GET /api/health` — Comprehensive health check verifying Ghostscript and pstoedit detection
- `POST /api/source` — Upload PDF/AI file (Header: `X-File-Name`, Body: binary file stream)
- `GET /api/source/:id/pdf` — Retrieve normalized preview PDF
- `GET /api/source/:id/analyze/:page` — Analyze page for vector paths and raster blocking
- `GET /api/source/:id/plt/:page?units=40` — Convert single page to HPGL PLT
- `GET /api/file/:id/:name` — Download converted PLT
- `POST /api/batch-zip` — Convert multiple selected pages and package into a ZIP
- `GET /api/zip/:id` — Download batch ZIP
