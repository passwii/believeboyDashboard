/**
 * Daily Report Page - Complex Components
 * 销售日报页面的复杂组件
 */

'use client'

import { motion, AnimatePresence } from 'framer-motion'
import type { DragEvent } from 'react'
import { AlertCircle, CalendarDays, CheckCircle2, Download, FileSearch, Loader2, Package, Rocket, Sparkles, Upload } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import { FILE_CONFIG } from '../_types/constants'
import { getStatusMeta } from '../_types/utils'
import type { ProjectOption, SubmitState, UploadState } from '../_types'
import { UploadRow, StatusPill, UploadProgressRail } from './index'
import { getItemVariants, getStatusVariants } from '../_types/animations'

// ==================== 拖拽上传区域 ====================

interface DragDropZoneProps {
  dragActive: boolean
  onDrop: (event: DragEvent<HTMLDivElement>) => void
  onDragOver: (event: DragEvent<HTMLDivElement>) => void
  onDragLeave: (event: DragEvent<HTMLDivElement>) => void
  onFileSelect: (files: FileList | null) => void
  onUploadAll: () => void
  canUpload: boolean
  matchingFiles: boolean
}

export function DragDropZone({
  dragActive,
  onDrop,
  onDragOver,
  onDragLeave,
  onFileSelect,
  onUploadAll,
  canUpload,
  matchingFiles,
}: DragDropZoneProps) {
  return (
    <motion.div
      animate={dragActive ? { scale: 1.01 } : { scale: 1 }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      className={cn(
        'relative overflow-hidden rounded-xl border-2 border-dashed p-6 text-center transition-all',
        dragActive
          ? 'border-primary bg-primary/5'
          : 'border-border bg-muted/30 hover:border-primary/30'
      )}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      <div className="space-y-4">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
          <Upload className="h-6 w-6 text-primary" />
        </div>
        
        <div>
          <p className="text-sm font-medium text-foreground">
            拖拽文件到此处，或
            <label className="ml-1 cursor-pointer text-primary hover:underline">
              点击选择
              <input
                type="file"
                multiple
                accept=".txt,.xlsx,.csv"
                className="sr-only"
                onChange={(e) => onFileSelect(e.target.files)}
              />
            </label>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            支持自动识别：销售、广告、库存报告
          </p>
        </div>

        <div className="flex justify-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => document.getElementById('batch-file-picker')?.click()}
          >
            <FileSearch className="mr-1 h-4 w-4" />
            批量识别
          </Button>
          <input
            id="batch-file-picker"
            type="file"
            multiple
            accept=".txt,.xlsx,.csv"
            className="sr-only"
            onChange={(e) => onFileSelect(e.target.files)}
          />
          <Button
            type="button"
            size="sm"
            onClick={onUploadAll}
            disabled={!canUpload || matchingFiles}
            className="bg-primary hover:bg-primary/90"
          >
            {matchingFiles ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-1 h-4 w-4" />
            )}
            一键上传
          </Button>
        </div>
      </div>
    </motion.div>
  )
}

// ==================== 文件状态概览卡片 ====================

interface FileStatusOverviewProps {
  uploadState: UploadState
  shouldReduceMotion: boolean | null
}

export function FileStatusOverview({ uploadState, shouldReduceMotion }: FileStatusOverviewProps) {
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {FILE_CONFIG.map((fileItem) => {
        const state = uploadState[fileItem.key]
        const meta = getStatusMeta(state)
        return (
          <motion.div
            key={fileItem.key}
            layout
            whileHover={shouldReduceMotion ? undefined : { y: -2 }}
            transition={{ duration: shouldReduceMotion ? 0.1 : 0.2, ease: 'easeOut' }}
            className="rounded-xl border border-border bg-muted/40 p-3"
          >
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="font-semibold text-foreground">{fileItem.title}</span>
              <span className="text-xs text-muted-foreground">{meta.text}</span>
            </div>
            <UploadProgressRail meta={meta} reduceMotion={!!shouldReduceMotion} />
            <p className="mt-2 truncate text-xs text-muted-foreground">
              {state.uploaded?.originalFilename ?? state.selectedFile?.name ?? '尚未选择文件'}
            </p>
          </motion.div>
        )
      })}
    </div>
  )
}

// ==================== 参数设置卡片 ====================

interface ParameterCardProps {
  projectName: string
  setProjectName: (value: string) => void
  reportDate: string
  setReportDate: (value: string) => void
  formError: string | null
  setFormError: (value: string | null) => void
  projects: ProjectOption[]
  projectsLoading: boolean
  projectLoadError: string | null
  manualProjectInput: boolean
  setManualProjectInput: (value: boolean) => void
  uploadedCount: number
  shouldReduceMotion: boolean | null
}

export function ParameterCard({
  projectName,
  setProjectName,
  reportDate,
  setReportDate,
  formError,
  setFormError,
  projects,
  projectsLoading,
  projectLoadError,
  manualProjectInput,
  setManualProjectInput,
  uploadedCount,
  shouldReduceMotion,
}: ParameterCardProps) {
  const itemVariants = getItemVariants(shouldReduceMotion)
  const statusVariants = getStatusVariants(shouldReduceMotion)

  return (
    <motion.div variants={itemVariants}>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Package className="h-5 w-5 text-primary" />
            参数设置
          </CardTitle>
          <CardDescription>
            设置项目和报表日期，作为上传和生成日报的前置条件
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 状态概览 */}
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-muted/50 p-2.5">
              <p className="text-[11px] text-muted-foreground">项目名称</p>
              <p className="mt-1 text-sm font-semibold text-foreground">
                {projectName.trim() ? '已填写' : '未填写'}
              </p>
            </div>
            <div className="rounded-lg border border-border bg-muted/50 p-2.5">
              <p className="text-[11px] text-muted-foreground">报表日期</p>
              <p className="mt-1 text-sm font-semibold text-foreground">
                {reportDate ? '已选择' : '未选择'}
              </p>
            </div>
            <div className="rounded-lg border border-border bg-muted/50 p-2.5">
              <p className="text-[11px] text-muted-foreground">文件完成度</p>
              <p className="mt-1 text-sm font-semibold text-foreground">{uploadedCount}/3</p>
            </div>
          </div>

          <Separator />

          {/* 项目名称输入 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="project_name" className="text-sm font-medium text-foreground">
                项目名称
              </label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setManualProjectInput((prev) => !prev)}
                className="h-7 px-2 text-xs"
              >
                {manualProjectInput ? '改用下拉候选' : '手动输入'}
              </Button>
            </div>
            {manualProjectInput ? (
              <Input
                id="project_name"
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                placeholder="输入项目名称"
              />
            ) : (
              <>
                <Input
                  id="project_name"
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                  placeholder={projectsLoading ? '项目加载中...' : '输入或选择项目'}
                  disabled={projectsLoading}
                  list="project-options"
                />
                <datalist id="project-options">
                  {projects.map((project) => (
                    <option key={project.name} value={project.name} />
                  ))}
                </datalist>
              </>
            )}
            {projectLoadError ? (
              <p className="text-xs text-destructive">{projectLoadError}</p>
            ) : null}
          </div>

          {/* 报表日期 */}
          <div className="space-y-2">
            <label htmlFor="report_date" className="text-sm font-medium text-foreground">
              报表日期
            </label>
            <div className="flex flex-wrap gap-2">
              <Input
                id="report_date"
                type="date"
                value={reportDate}
                onChange={(event) => setReportDate(event.target.value)}
                className="max-w-xs"
              />
              <Button
                type="button"
                variant="secondary"
                onClick={() => setReportDate(yesterdayDateString())}
              >
                <CalendarDays className="mr-1 h-4 w-4" />
                昨天
              </Button>
            </div>
          </div>

          {/* 错误提示 */}
          <AnimatePresence>
            {formError ? (
              <motion.div
                variants={statusVariants}
                initial="hidden"
                animate="show"
                exit="exit"
                className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              >
                {formError}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </CardContent>
      </Card>
    </motion.div>
  )
}

// ==================== 执行控制卡片 ====================

interface ExecutionCardProps {
  canGenerate: boolean
  uploadedCount: number
  latestAction: string
  submitState: SubmitState
  onGenerate: () => void
  shouldReduceMotion: boolean | null
}

export function ExecutionCard({
  canGenerate,
  uploadedCount,
  latestAction,
  submitState,
  onGenerate,
  shouldReduceMotion,
}: ExecutionCardProps) {
  const itemVariants = getItemVariants(shouldReduceMotion)
  const statusVariants = getStatusVariants(shouldReduceMotion)

  return (
    <motion.div variants={itemVariants}>
      <Card className="bg-primary text-primary-foreground">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Rocket className="h-5 w-5" />
            执行控制
          </CardTitle>
          <CardDescription className="text-primary-foreground/80">
            完成所有前置条件后，点击生成日报
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 状态概览 */}
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-md border border-primary-foreground/20 bg-primary-foreground/10 p-3">
              <p className="text-xs text-primary-foreground/80">上传进度</p>
              <p className="mt-1 text-sm font-semibold">{uploadedCount}/3</p>
            </div>
            <div className="rounded-md border border-primary-foreground/20 bg-primary-foreground/10 p-3">
              <p className="text-xs text-primary-foreground/80">可执行状态</p>
              <p className="mt-1 text-sm font-semibold">{canGenerate ? '可生成' : '未就绪'}</p>
            </div>
            <div className="rounded-md border border-primary-foreground/20 bg-primary-foreground/10 p-3">
              <p className="text-xs text-primary-foreground/80">最近动作</p>
              <p className="mt-1 truncate text-sm font-semibold">{latestAction}</p>
            </div>
          </div>

          {/* 生成按钮 */}
          <motion.div
            whileHover={shouldReduceMotion ? undefined : canGenerate ? { scale: 1.02 } : undefined}
            whileTap={shouldReduceMotion ? undefined : canGenerate ? { scale: 0.98 } : undefined}
            transition={{ duration: shouldReduceMotion ? 0.1 : 0.18 }}
          >
            <Button
              type="button"
              className="h-12 w-full bg-white text-primary hover:bg-white/90"
              onClick={onGenerate}
              disabled={!canGenerate}
            >
              {submitState.status === 'submitting' ? (
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              ) : (
                <Sparkles className="mr-2 h-5 w-5" />
              )}
              {submitState.status === 'submitting' ? '处理中...' : '生成日报'}
            </Button>
          </motion.div>

          {/* 文件名展示 */}
          <AnimatePresence mode="popLayout">
            {submitState.filename ? (
              <motion.div
                variants={statusVariants}
                initial="hidden"
                animate="show"
                exit="exit"
              >
                <Badge
                  variant="outline"
                  className="justify-center gap-1 border-primary-foreground/30 text-primary-foreground"
                >
                  <Download className="h-3.5 w-3.5" />
                  {submitState.filename}
                </Badge>
              </motion.div>
            ) : (
              <motion.p
                key="hint"
                variants={statusVariants}
                initial="hidden"
                animate="show"
                exit="exit"
                className="text-center text-xs text-primary-foreground/70"
              >
                生成后将自动下载日报文件
              </motion.p>
            )}
          </AnimatePresence>

          {/* 状态消息 */}
          <AnimatePresence mode="wait">
            {submitState.status === 'success' && (
              <motion.div
                key="success"
                variants={statusVariants}
                initial="hidden"
                animate="show"
                exit="exit"
                className="flex items-center gap-2 rounded-md border border-emerald-400/50 bg-emerald-500/20 px-3 py-2 text-sm text-emerald-100"
              >
                <CheckCircle2 className="h-4 w-4" />
                {submitState.message}
              </motion.div>
            )}
            {submitState.status === 'error' && (
              <motion.div
                key="error"
                variants={statusVariants}
                initial="hidden"
                animate="show"
                exit="exit"
                className="flex items-center gap-2 rounded-md border border-rose-400/40 bg-rose-500/20 px-3 py-2 text-sm text-rose-100"
              >
                <AlertCircle className="h-4 w-4" />
                {submitState.message}
              </motion.div>
            )}
            {submitState.status === 'submitting' && (
              <motion.div
                key="submitting"
                variants={statusVariants}
                initial="hidden"
                animate="show"
                exit="exit"
                className="flex items-center gap-2 rounded-md border border-primary-foreground/30 bg-primary-foreground/20 px-3 py-2 text-sm text-primary-foreground"
              >
                <Loader2 className="h-4 w-4 animate-spin" />
                {submitState.message}
              </motion.div>
            )}
          </AnimatePresence>
        </CardContent>
      </Card>
    </motion.div>
  )
}

// ==================== 文件上传工作台 ====================

interface FileUploadWorkstationProps {
  dragActive: boolean
  onDrop: (event: DragEvent<HTMLDivElement>) => void
  onDragOver: (event: DragEvent<HTMLDivElement>) => void
  onDragLeave: (event: DragEvent<HTMLDivElement>) => void
  onFileSelect: (files: FileList | null) => void
  onUploadAll: () => void
  canUpload: boolean
  matchingFiles: boolean
  uploadState: UploadState
  recognitionMessages: string[]
  onPickFile: (key: string, file: File | null, reason?: string) => void
  onUpload: (key: string) => void
  onReset: (key: string) => void
  shouldReduceMotion: boolean | null
}

export function FileUploadWorkstation({
  dragActive,
  onDrop,
  onDragOver,
  onDragLeave,
  onFileSelect,
  onUploadAll,
  canUpload,
  matchingFiles,
  uploadState,
  recognitionMessages,
  onPickFile,
  onUpload,
  onReset,
  shouldReduceMotion,
}: FileUploadWorkstationProps) {
  const itemVariants = getItemVariants(shouldReduceMotion)
  const logItemVariants = getLogItemVariants(shouldReduceMotion)
  const statusVariants = getStatusVariants(shouldReduceMotion)

  return (
    <motion.div variants={itemVariants}>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <FileSearch className="h-5 w-5 text-primary" />
            文件上传
          </CardTitle>
          <CardDescription>
            拖拽文件自动识别，或手动选择文件上传
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* 拖拽区域 */}
          <DragDropZone
            dragActive={dragActive}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onFileSelect={onFileSelect}
            onUploadAll={onUploadAll}
            canUpload={canUpload}
            matchingFiles={matchingFiles}
          />

          {/* 文件状态概览 */}
          <FileStatusOverview uploadState={uploadState} shouldReduceMotion={shouldReduceMotion} />

          {/* 识别消息 */}
          <AnimatePresence>
            {recognitionMessages.length > 0 && (
              <motion.div
                variants={statusVariants}
                initial="hidden"
                animate="show"
                exit="exit"
                className="max-h-44 space-y-1 overflow-auto rounded-md border bg-muted/20 p-3 text-xs"
              >
                {recognitionMessages.map((message) => (
                  <motion.p
                    key={message}
                    variants={logItemVariants}
                    initial="hidden"
                    animate="show"
                    exit="exit"
                    className={cn(
                      'text-foreground',
                      message.includes('失败') && 'text-destructive',
                      message.includes('成功') && 'text-emerald-600'
                    )}
                  >
                    {message}
                  </motion.p>
                ))}
              </motion.div>
            )}
          </AnimatePresence>

          {/* 详细上传区域 - 可折叠 */}
          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" className="w-full justify-between">
                <span>详细上传控制</span>
                <span className="text-xs text-muted-foreground">
                  点击展开/收起
                </span>
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pt-3">
              {FILE_CONFIG.map((fileItem) => (
                <UploadRow
                  key={fileItem.key}
                  fileItem={fileItem}
                  state={uploadState[fileItem.key]}
                  canUpload={canUpload}
                  reduceMotion={!!shouldReduceMotion}
                  onPickFile={onPickFile}
                  onUpload={onUpload}
                  onReset={onReset}
                />
              ))}
            </CollapsibleContent>
          </Collapsible>
        </CardContent>
      </Card>
    </motion.div>
  )
}

import { getLogItemVariants } from '../_types/animations'
