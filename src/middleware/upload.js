import multer from "multer";

const MAX_SPREADSHEET_SIZE_BYTES = 10 * 1024 * 1024;
const SPREADSHEET_EXTENSIONS = new Set([".csv", ".xls", ".xlsx", ".xlsm"]);
const SPREADSHEET_MIME_TYPES = new Set([
    "",
    "application/octet-stream",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel.sheet.macroenabled.12",
    "text/csv",
    "application/csv",
]);

class UnsupportedSpreadsheetError extends Error {}

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_SPREADSHEET_SIZE_BYTES,
        files: 1,
    },
    fileFilter(_req, file, callback) {
        const extension = file.originalname.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
        if (
            !SPREADSHEET_EXTENSIONS.has(extension)
            || !SPREADSHEET_MIME_TYPES.has(file.mimetype.toLowerCase())
        ) {
            callback(new UnsupportedSpreadsheetError(
                "Upload an Excel or CSV spreadsheet (.xls, .xlsx, .xlsm, or .csv).",
            ));
            return;
        }
        callback(null, true);
    },
});

export const spreadsheetUpload = upload.single("file");

export function handleSpreadsheetUploadError(error, _req, res, next) {
    if (error instanceof multer.MulterError) {
        const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        return res.status(status).json({ error: error.message });
    }
    if (error instanceof UnsupportedSpreadsheetError) {
        return res.status(415).json({ error: error.message });
    }
    return next(error);
}