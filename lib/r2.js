// lib/r2.js
// Cloudflare R2 Client (S3-compatible API with zero egress fees)

process.loadEnvFile?.();
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucketName = process.env.R2_BUCKET_NAME || "caption-studio";

const isConfigured = Boolean(accountId && accessKeyId && secretAccessKey);

let r2Client = null;
if (isConfigured) {
  r2Client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
}

/**
 * Generate a pre-signed PUT URL so the browser can upload directly to R2.
 */
async function getUploadPresignedUrl(key, contentType = "video/mp4", expiresInSeconds = 3600) {
  if (!r2Client) throw new Error("Cloudflare R2 is not configured in .env");
  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    ContentType: contentType,
  });
  return await getSignedUrl(r2Client, command, { expiresIn: expiresInSeconds });
}

/**
 * Generate a pre-signed GET URL for secure video streaming or downloading.
 */
async function getDownloadPresignedUrl(key, expiresInSeconds = 86400) {
  if (!r2Client) throw new Error("Cloudflare R2 is not configured in .env");
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: key,
  });
  return await getSignedUrl(r2Client, command, { expiresIn: expiresInSeconds });
}

/**
 * Upload a local file directly to R2.
 */
async function uploadFileToR2(localFilePath, key, contentType = "video/mp4") {
  if (!r2Client) return null;
  const fs = require("fs");
  const fileStream = fs.createReadStream(localFilePath);
  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: fileStream,
    ContentType: contentType,
  });
  await r2Client.send(command);
  return key;
}

/**
 * Download an object from R2 to a local file path.
 */
async function downloadFileFromR2(key, localDestPath) {
  if (!r2Client) return false;
  const fs = require("fs");
  const { pipeline } = require("stream/promises");
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: key,
  });
  const response = await r2Client.send(command);
  await pipeline(response.Body, fs.createWriteStream(localDestPath));
  return true;
}

/**
 * Delete an object from R2.
 */
async function deleteFromR2(key) {
  if (!r2Client) return;
  const command = new DeleteObjectCommand({
    Bucket: bucketName,
    Key: key,
  });
  return await r2Client.send(command);
}

module.exports = {
  isConfigured,
  bucketName,
  getUploadPresignedUrl,
  getDownloadPresignedUrl,
  uploadFileToR2,
  downloadFileFromR2,
  deleteFromR2,
};
