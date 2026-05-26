# Platform Inspection Feature - Complete Code Map

## Overview
The platform-inspection feature is a comprehensive dashboard for recording and managing platform inspection reports. It includes health metrics, compliance data, screenshots, and threshold-based warnings.

---

## Frontend Structure

### Main Page & Layout
- **Page Component**: `frontend/app/dashboard/data-management/platform-inspection/page.tsx`
  - Metadata: "平台巡检" (Platform Inspection)
  - Renders: `InspectionClient` component
  
- **Client Component**: `frontend/app/dashboard/data-management/platform-inspection/inspection-client.tsx`
  - Main entry point with tab navigation (Overview / History)
  - Manages dialog state for form editing
  - Handles period loading and project selection
  - Key states: `activeTab`, `selectedProjectId`, `currentPeriodId`, `isDialogOpen`, `refreshKey`

### Sub-Components Directory
Location: `frontend/app/dashboard/data-management/platform-inspection/components/`

#### 1. **inspection-form.tsx** (680 lines)
The main form for editing inspection reports. Handles:
- **Form Data**: Health metrics, compliance data, status summary
- **Screenshot Management**: Upload, delete, caption editing
- **Features**:
  - Threshold warning detection with severity levels (warning/critical)
  - Form validation and auto-save
  - Draft/Submit workflow
  - Screenshot upload with progress tracking
  
**Key Handlers**:
- `handleHealthChange()` - Update health metrics
- `handleComplianceChange()` - Update compliance metrics
- `handleUploadScreenshot()` - Upload and attach screenshots
- `handleDeleteScreenshot()` - Delete existing screenshots
- `handleSaveDraft()` - Save draft data
- `handleSubmit()` - Submit final report

**Health Fields** (metrics inputs):
- `account_health_rating` (select): Healthy, Good, At Risk, Critical
- `odr` - Order Defect Rate (%)
- `late_shipment_rate` - Late Shipment Rate (%)
- `pre_fulfillment_cancel_rate` - Pre-fulfillment Cancel Rate (%)
- `valid_tracking_rate` - Valid Tracking Rate (%)
- `on_time_delivery_rate` - On-time Delivery Rate (%)

**Compliance Fields**:
- `policy_violations` - Policy Violations (count)
- `ip_complaints` - IP Complaints (count)
- `restricted_product_warnings` - Restricted Product Warnings (count)
- `listing_suppressed_count` - Listing Suppressed Count (count)
- `account_deactivation_risk` - Account Deactivation Risk (boolean toggle)

**Screenshot Management**:
- Uses `UploadZone` component for file upload
- Supports drag-drop and paste (Ctrl+V)
- Image compression and thumbnail generation on backend
- Per-screenshot captions

#### 2. **inspection-overview.tsx** (18432 bytes)
Grid view of all projects in current inspection period
- Shows status (submitted/draft/overdue/pending)
- Health & compliance metrics preview
- Screenshot grid (max 4 per project)
- Links to edit form

#### 3. **inspection-history.tsx** (16996 bytes)
Historical view of past inspection reports
- Filterable by period and project
- Shows submission status and metrics
- Pagination support

### Types & API Layer
- **Types File**: `frontend/app/dashboard/data-management/platform-inspection/types.ts`
  - Re-exports all interfaces from `inspection-api.ts`
  
- **API Layer**: `frontend/lib/inspection-api.ts` (305 lines)
  - Defines all TypeScript interfaces
  - API client functions for backend communication
  - Base URL: `/api/backend` → proxied to backend

**Key API Functions**:
```typescript
fetchInspectionTemplate()              // Get form template with thresholds
fetchCurrentPeriod()                   // Get current inspection week
fetchPeriods(limit, offset)            // List all periods
fetchPeriodOverview(periodId)          // Overview for a period
fetchReport(periodId, projectId)       // Get existing report
saveReport(periodId, projectId, data)  // Save draft
submitReport(periodId, projectId)      // Submit report
uploadScreenshot(file, reportId)       // Upload single screenshot
deleteScreenshot(screenshotId)         // Delete screenshot
fetchInspectionHistory(params)         // Get history with filters
```

### Image Upload & Paste Handling
- **Upload Component**: `frontend/components/ui/upload-zone.tsx` (200+ lines)
  - Multi-file drop support with drag-drop
  - **Paste Handling**: 
    - Click dashed box to activate paste mode (toggle `isPasteActive`)
    - Listen to `document.paste` event when paste mode is active
    - Auto-detect image/* or specific file types
    - Supports: images, PDFs, XLSX/XLS
  - File validation: size limit (default 10MB), type checking
  - Preview generation for images/PDFs
  - UI states: uploading, drag-active, paste-active

**Paste Handling Logic** (lines 122-148):
```typescript
useEffect(() => {
  if (!isPasteActive || disabled || isUploading) return
  
  const handlePaste = (e: ClipboardEvent) => {
    const items = e.clipboardData?.items
    for (const item of items) {
      const acceptTypes = accept.split(',').map(...)
      const matchImage = acceptTypes.some(...)
      const matchFile = acceptTypes.includes(...)
      
      if (matchImage || matchFile) {
        e.preventDefault()
        const file = item.getAsFile()
        void handleFileSelect(file)
        break
      }
    }
  }
  
  document.addEventListener('paste', handlePaste)
  return () => document.removeEventListener('paste', handlePaste)
}, [isPasteActive, disabled, isUploading, accept])
```

### Frontend API Proxy Route
- **Route**: `frontend/app/api/inspections/screenshot-upload/route.ts`
  - POST endpoint that forwards to backend
  - Adds authentication headers (X-API-Key, X-Operator, X-Is-Admin)
  - Preserves multipart body using `request.arrayBuffer()`
  - Error handling and normalization

---

## Backend Structure

### Database Models
- **File**: `backend/app/models/inspection.py` (120 lines)

**Tables**:
1. **InspectionPeriod**
   - `id` (BigInteger, PK)
   - `week_start` (Date, unique)
   - `week_end` (Date)
   - `deadline` (DateTime)
   - `created_at` (DateTime)
   - Relationship: `reports` (one-to-many)

2. **InspectionReport**
   - `id` (BigInteger, PK)
   - `period_id` (FK → InspectionPeriod, cascade delete)
   - `project_id` (FK → Project, cascade delete)
   - `status` (String: draft, submitted, overdue)
   - `health_data` (JSON)
   - `compliance_data` (JSON)
   - `status_summary` (Text, optional)
   - `submitted_by` (String, optional)
   - `submitted_at` (DateTime, optional)
   - `created_at`, `updated_at` (DateTime)
   - Relationships: `period`, `screenshots`
   - Unique constraint: `(period_id, project_id)`
   - Indexes: period_id, project_id, period_status

3. **InspectionScreenshot**
   - `id` (BigInteger, PK)
   - `report_id` (FK → InspectionReport, cascade delete)
   - `r2_key` (String[512]) - Path to compressed image in R2
   - `thumbnail_key` (String[512], optional) - Path to thumbnail in R2
   - `filename` (String[256])
   - `content_type` (String[64])
   - `file_size` (Integer) - Size in bytes
   - `caption` (String[256], optional)
   - `sort_order` (Integer, default 0)
   - `created_at` (DateTime)
   - Index: report_id

### Schemas (Pydantic Models)
- **File**: `backend/app/schemas/inspection.py` (144 lines)

### API Endpoints
- **File**: `backend/app/api/v1/endpoints/inspections.py` (378 lines)
- **Router**: `/api/v1/inspections` (protected by default)

**Key Endpoints**:
- `GET /template` - Get form field definitions
- `GET /periods/current` - Get or create current week
- `GET /periods/{id}/overview` - Get grid view
- `GET /periods/{period_id}/projects/{project_id}` - Get report
- `POST /periods/{period_id}/projects/{project_id}` - Create/update report
- `POST /periods/{period_id}/projects/{project_id}/submit` - Submit report
- `POST /screenshots/upload` - Upload screenshot
- `DELETE /screenshots/{id}` - Delete screenshot
- `GET /history` - Get historical reports

### Service Layer
- **File**: `backend/app/services/inspection_service.py` (469 lines)

**Key Functions**:
- `get_or_create_current_period(db)` - Get current week or create
- `get_overview(db, period_id, ...)` - Build overview with all projects
- `get_report(db, period_id, project_id, settings)` - Fetch single report
- `create_or_update_report(db, ...)` - Save draft
- `submit_report(db, report_id, operator)` - Submit and validate
- `check_thresholds(report)` - Validate against thresholds
- `upload_screenshot(db, settings, file, report_id, project_slug)` - Main upload handler
  - Validates file type and size
  - Compresses original image (resize if > 1920px, JPEG@80)
  - Generates thumbnail (320px max, JPEG@70)
  - Uploads both to R2
  - Returns database record
- `delete_screenshot(db, settings, screenshot_id)` - Delete from DB and R2
- `get_report_screenshot_urls(settings, screenshots)` - Build response

**Image Processing**:
- `_compress_image(file_bytes, max_width=1920, quality=80)` - Compress and convert to JPEG
- `_generate_thumbnail(file_bytes, max_width=320, quality=70)` - Generate JPEG thumbnail

**Configuration**:
- `_ALLOWED_IMAGE_TYPES` = {image/jpeg, image/png, image/webp, image/gif}
- `_MAX_SCREENSHOT_BYTES` = 10 MB
- `_COMPRESS_MAX_WIDTH` = 1920 px
- `_COMPRESS_QUALITY` = 80
- `_THUMB_MAX_WIDTH` = 320 px
- `_THUMB_QUALITY` = 70

### R2 Storage Service
- **File**: `backend/app/services/r2_service.py` (150+ lines)

**Key Functions**:
- `get_r2_client(settings)` - Get boto3 S3 client (singleton)
- `upload_file_to_r2(settings, file_data, filename, project_slug, file_type, content_type)`
  - Returns: {key, url, bucket, size}
  - Key format: `{project_slug}/{file_type}/{filename}`
- `upload_bytes_to_r2(settings, data, filename, project_slug, file_type, content_type)` - Wrapper
- `delete_file_from_r2(settings, key)` - Delete by R2 key
- `generate_presigned_url(settings, key, expires_in=3600)` - Generate signed URL

**R2 Folder Structure**:
```
{bucket}/
├── {project_name}/
│   └── inspection-screenshots/
│       ├── {uuid}.jpg              (compressed original)
│       └── {uuid}_thumb.jpg        (thumbnail)
```

### Database Migrations
- Migration 1: `backend/alembic/versions/20260525_144_add_inspection_tables.py`
- Migration 2: `backend/alembic/versions/20260525_145_add_inspection_thumbnail_key.py`

---

## Feature Workflows

### 1. Upload Screenshots with Paste
```
User clicks dashed box → isPasteActive = true (visual feedback: blue border)
User presses Ctrl+V
→ UploadZone listens to paste event
→ Validates file type (image/*, pdf, etc.)
→ Creates ObjectURL for preview
→ If no report: auto-save draft first
→ uploadScreenshot(file, reportId)
→ Frontend proxy: POST /api/inspections/screenshot-upload
→ Backend: compress, thumbnail, upload to R2
→ Frontend: replace ObjectURL with presigned URL
```

### 2. Submit Report
```
User clicks "Submit" button
→ If no report: auto-save draft first
→ API: POST /periods/{id}/projects/{projectId}/submit
→ Backend: check thresholds, return warnings
→ Frontend: shows success, closes dialog
```

### 3. Delete Screenshot
```
User clicks delete on screenshot
→ If new: remove from local state only
→ If existing:
  - API: DELETE /api/v1/inspections/screenshots/{id}
  - Backend: delete from DB and R2 (image + thumbnail)
  - Frontend: remove from list
```

---

## Complete File List

**Frontend**:
- `frontend/app/dashboard/data-management/platform-inspection/page.tsx`
- `frontend/app/dashboard/data-management/platform-inspection/inspection-client.tsx`
- `frontend/app/dashboard/data-management/platform-inspection/types.ts`
- `frontend/app/dashboard/data-management/platform-inspection/components/inspection-form.tsx`
- `frontend/app/dashboard/data-management/platform-inspection/components/inspection-overview.tsx`
- `frontend/app/dashboard/data-management/platform-inspection/components/inspection-history.tsx`
- `frontend/app/api/inspections/screenshot-upload/route.ts`
- `frontend/lib/inspection-api.ts`
- `frontend/components/ui/upload-zone.tsx`

**Backend**:
- `backend/app/models/inspection.py`
- `backend/app/schemas/inspection.py`
- `backend/app/api/v1/endpoints/inspections.py`
- `backend/app/services/inspection_service.py`
- `backend/app/services/r2_service.py`
- `backend/alembic/versions/20260525_144_add_inspection_tables.py`
- `backend/alembic/versions/20260525_145_add_inspection_thumbnail_key.py`
