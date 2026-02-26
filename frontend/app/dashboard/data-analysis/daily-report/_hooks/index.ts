/**
 * Daily Report Page - Custom Hooks
 * 销售日报页面的自定义Hooks
 */

'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DragEvent } from 'react'
import { API_BASE, authHeaders, FILE_CONFIG, initialUploadState, UPLOAD_TYPES } from '../_types/constants'
import { extractFilenameFromHeader, isUploadType, validateFile, yesterdayDateString } from '../_types/utils'
import { recognizeDataFile } from '@/lib/file-recognition'
import type {
  ProjectOption,
  SubmitState,
  UploadState,
  UploadStateItem,
  UploadType,
} from '../_types'

export function useProjects() {
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null)
  const [manualProjectInput, setManualProjectInput] = useState(false)

  useEffect(() => {
    const loadProjects = async () => {
      setProjectsLoading(true)
      setProjectLoadError(null)
      try {
        const response = await fetch(`${API_BASE}/api/v1/projects`, {
          cache: 'no-store',
          headers: authHeaders(),
        })
        if (!response.ok) {
          throw new Error(`项目列表加载失败 (${response.status})`)
        }
        const data = (await response.json()) as ProjectOption[]
        setProjects(data)
      } catch (error) {
        setProjectLoadError(error instanceof Error ? error.message : '项目列表加载失败')
        setManualProjectInput(true)
      } finally {
        setProjectsLoading(false)
      }
    }
    void loadProjects()
  }, [])

  return {
    projects,
    projectsLoading,
    projectLoadError,
    manualProjectInput,
    setManualProjectInput,
  }
}

export function useFormState() {
  const [projectName, setProjectName] = useState('')
  const [reportDate, setReportDate] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const canUpload = projectName.trim().length > 0

  return {
    projectName,
    setProjectName,
    reportDate,
    setReportDate,
    formError,
    setFormError,
    canUpload,
  }
}

export function useUploadState() {
  const [uploadState, setUploadState] = useState<UploadState>(initialUploadState())
  const [matchingFiles, setMatchingFiles] = useState(false)
  const [recognitionMessages, setRecognitionMessages] = useState<string[]>([])

  const allUploaded = useMemo(
    () => FILE_CONFIG.every((item) => uploadState[item.key].status === 'success' && uploadState[item.key].uploaded),
    [uploadState]
  )

  const uploadedCount = useMemo(
    () => FILE_CONFIG.filter((item) => uploadState[item.key].status === 'success' && uploadState[item.key].uploaded).length,
    [uploadState]
  )

  const onPickFile = useCallback((key: UploadType, file: File | null, reason = '手动选择文件') => {
    if (!file) return

    if (!validateFile(file, key)) {
      setUploadState((prev) => ({
        ...prev,
        [key]: {
          ...prev[key],
          status: 'error',
          error: '文件格式不支持，请上传正确格式',
          selectedFile: null,
          selectedReason: null,
          uploaded: null,
        },
      }))
      return
    }

    setUploadState((prev) => ({
      ...prev,
      [key]: {
        ...prev[key],
        selectedFile: file,
        selectedReason: reason,
        status: 'idle',
        error: null,
        uploaded: null,
      },
    }))
  }, [])

  const mapDetectedFiles = useCallback(async (files: File[]) => {
    if (!files.length) return
    setRecognitionMessages([])
    setMatchingFiles(true)

    const messages: string[] = []
    const assignedTypes = new Set<UploadType>()
    const recognized = await Promise.all(
      files.map(async (file) => {
        const match = await recognizeDataFile(file)
        return { file, ...match }
      })
    )

    recognized.forEach((item) => {
      if (!isUploadType(item.type)) {
        if (item.type === 'payment_report') {
          messages.push(`已跳过 ${item.file.name}：识别为付款报告（本页面不需要）`)
          return
        }
        messages.push(`无法识别 ${item.file.name}：${item.reason}`)
        return
      }

      if (assignedTypes.has(item.type)) {
        messages.push(`已跳过 ${item.file.name}：同批次重复识别为 ${item.type}`)
        return
      }

      assignedTypes.add(item.type)
      onPickFile(item.type, item.file, `拖拽识别：${item.reason}`)
      messages.push(`已识别 ${item.file.name} -> ${item.type}`)
    })

    setRecognitionMessages(messages)
    setMatchingFiles(false)
  }, [onPickFile])

  const uploadFile = useCallback(async (key: UploadType, projectName: string, canUpload: boolean) => {
    if (!canUpload) {
      throw new Error('项目名称不能为空')
    }

    const target = uploadState[key]
    if (!target.selectedFile) {
      throw new Error('请先选择文件')
    }

    setUploadState((prev) => ({
      ...prev,
      [key]: { ...prev[key], status: 'uploading', error: null, uploaded: null },
    }))

    const formData = new FormData()
    formData.append('file', target.selectedFile)
    formData.append('project_name', projectName.trim())
    formData.append('file_type', key)

    try {
      const response = await fetch(`${API_BASE}/api/v1/uploads`, {
        method: 'POST',
        body: formData,
        headers: authHeaders(),
      })

      if (!response.ok) {
        const message = await response.text()
        throw new Error(message || '文件上传失败，请重试')
      }

      const payload = (await response.json()) as {
        file_id?: string
        file_path?: string
        filename?: string
        original_filename?: string
      }

      if (!payload.file_path || !payload.filename || !payload.original_filename) {
        throw new Error('上传成功但响应缺少必要字段')
      }

      setUploadState((prev) => ({
        ...prev,
        [key]: {
          ...prev[key],
          status: 'success',
          error: null,
          uploaded: {
            filePath: payload.file_path,
            filename: payload.filename,
            originalFilename: payload.original_filename,
          },
        },
      }))
    } catch (error) {
      setUploadState((prev) => ({
        ...prev,
        [key]: {
          ...prev[key],
          status: 'error',
          error: error instanceof Error ? error.message : '文件上传失败，请重试',
          uploaded: null,
        },
      }))
      throw error
    }
  }, [uploadState])

  const uploadAll = useCallback(async (projectName: string, canUpload: boolean) => {
    for (const item of FILE_CONFIG) {
      const state = uploadState[item.key]
      if (state.selectedFile && state.status !== 'success') {
        // eslint-disable-next-line no-await-in-loop
        await uploadFile(item.key, projectName, canUpload)
      }
    }
  }, [uploadState, uploadFile])

  const clearUpload = useCallback((key: UploadType) => {
    setUploadState((prev) => ({
      ...prev,
      [key]: {
        status: 'idle',
        selectedFile: null,
        selectedReason: null,
        uploaded: null,
        error: null,
      },
    }))
  }, [])

  return {
    uploadState,
    setUploadState,
    matchingFiles,
    recognitionMessages,
    allUploaded,
    uploadedCount,
    onPickFile,
    mapDetectedFiles,
    uploadFile,
    uploadAll,
    clearUpload,
  }
}

export function useReportGeneration(
  projectName: string,
  reportDate: string,
  canGenerate: boolean,
  uploadState: UploadState
) {
  const [submitState, setSubmitState] = useState<SubmitState>({
    status: 'idle',
    message: null,
    filename: null,
  })

  const generateReport = useCallback(async () => {
    setSubmitState({ status: 'idle', message: null, filename: null })

    if (!canGenerate) {
      return { error: '表单信息不完整' }
    }

    setSubmitState({ status: 'submitting', message: '系统处理中，请稍候...', filename: null })

    try {
      // 创建任务
      const createJobResponse = await fetch(`${API_BASE}/api/v1/jobs`, {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          job_type: 'daily_report',
          file_id: uploadState.sales_report.uploaded?.filename ?? '',
          params: {
            project_name: projectName.trim(),
            report_date: reportDate,
            sales_report_path: uploadState.sales_report.uploaded?.filePath ?? '',
            ad_report_path: uploadState.ad_report.uploaded?.filePath ?? '',
            inventory_report_path: uploadState.inventory_report.uploaded?.filePath ?? '',
          },
        }),
      })

      if (!createJobResponse.ok) {
        const message = await createJobResponse.text()
        throw new Error(message || '生成失败，请重试')
      }

      const created = (await createJobResponse.json()) as { id: number }
      const jobId = created.id

      // 轮询任务状态
      let attempts = 0
      const maxAttempts = 120
      let failedMessage: string | null = null
      let finished = false

      while (attempts < maxAttempts && !finished) {
        attempts += 1
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 2000))
        // eslint-disable-next-line no-await-in-loop
        const statusResponse = await fetch(`${API_BASE}/api/v1/jobs/${jobId}`, {
          cache: 'no-store',
          headers: authHeaders(),
        })
        if (!statusResponse.ok) {
          // eslint-disable-next-line no-await-in-loop
          const msg = await statusResponse.text()
          throw new Error(msg || '任务状态查询失败')
        }

        // eslint-disable-next-line no-await-in-loop
        const statusPayload = (await statusResponse.json()) as {
          status: 'pending' | 'running' | 'success' | 'failed'
          runs?: Array<{ error_message?: string | null }>
        }

        if (statusPayload.status === 'failed') {
          failedMessage = statusPayload.runs?.[statusPayload.runs.length - 1]?.error_message ?? '任务执行失败'
          finished = true
          break
        }

        if (statusPayload.status === 'success') {
          finished = true
          break
        }
      }

      if (failedMessage) {
        throw new Error(failedMessage)
      }
      if (!finished) {
        throw new Error('任务执行超时，请稍后重试')
      }

      // 下载结果
      const response = await fetch(`${API_BASE}/api/v1/jobs/${jobId}/result`, {
        headers: authHeaders(),
      })
      if (!response.ok) {
        const message = await response.text()
        throw new Error(message || '结果下载失败')
      }

      const blob = await response.blob()
      const headerName = extractFilenameFromHeader(response.headers.get('Content-Disposition'))
      const fallbackName = `${projectName.trim()}_${reportDate}_日报.txt`
      const filename = headerName || fallbackName

      const downloadUrl = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = downloadUrl
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(downloadUrl)

      setSubmitState({
        status: 'success',
        message: `生成成功，已下载 ${filename}`,
        filename,
      })

      return { success: true, filename }
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      setSubmitState({
        status: 'error',
        message: `生成失败：${message}`,
        filename: null,
      })
      return { error: message }
    }
  }, [projectName, reportDate, canGenerate, uploadState])

  return {
    submitState,
    setSubmitState,
    generateReport,
  }
}
