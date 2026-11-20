import { requestUpload, type UploadProgressHandler } from "../request";

export interface UploadResponse {
  path: string;
  workspace_path: string;
  filename: string;
  media_type: string;
  url: string;
  access_url: string;
}

/**
 * Upload a chat attachment into the agent workspace ``inbound/`` directory.
 */
export async function uploadFile(
  agentId: string,
  file: File,
  onProgress?: UploadProgressHandler,
  signal?: AbortSignal,
): Promise<UploadResponse> {
  const formData = new FormData();
  formData.append("file", file);
  return requestUpload<UploadResponse>(
    `/agents/${agentId}/upload`,
    formData,
    { signal, timeoutMs: 15 * 60 * 1000 },
    onProgress,
  );
}

export const uploadImage = uploadFile;

export const uploadApi = { uploadFile, uploadImage };
