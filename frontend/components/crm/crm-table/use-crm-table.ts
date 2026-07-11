'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { FilterCondition, ListParams, Paginated } from '@/lib/crm/api/crm-client'

export type CrmSortOrder = 'asc' | 'desc'

export interface UseCrmTableParams<T> {
 queryKey: string
 fetchPage: (params: ListParams) => Promise<Paginated<T>>
 defaultPageSize?: number
 scope?: 'mine' | 'all'
}

export interface UseCrmTableReturn<T> {
 data: T[] | undefined
 total: number
 loading: boolean
 error: Error | null
 page: number
 pageSize: number
 sortBy: string | undefined
 sortOrder: CrmSortOrder | undefined
 keyword: string
 filters: FilterCondition[]
 scope: 'mine' | 'all' | undefined
 setPage: (next: number) => void
 setPageSize: (next: number) => void
 setKeyword: (next: string) => void
 setSort: (sortBy: string | undefined, sortOrder: CrmSortOrder | undefined) => void
 toggleSort: (sortBy: string) => void
 setFilters: (next: FilterCondition[]) => void
 setScope: (next: 'mine' | 'all' | undefined) => void
 reset: () => void
 refresh: () => Promise<void>
}

function parsePositiveInt(value: string | null, fallback: number): number {
 if (!value) return fallback
 const n = Number.parseInt(value, 10)
 if (!Number.isFinite(n) || n < 1) return fallback
 return n
}

function parseSortOrder(value: string | null): CrmSortOrder | undefined {
 return value === 'asc' || value === 'desc' ? value : undefined
}

function parseScope(value: string | null): 'mine' | 'all' | undefined {
 return value === 'mine' || value === 'all' ? value : undefined
}

function parseFilters(value: string | null): FilterCondition[] {
 if (!value) return []
 try {
 const decoded = JSON.parse(value)
 return Array.isArray(decoded) ? (decoded as FilterCondition[]) : []
 } catch {
 return []
 }
}

type UrlValue = string | number | undefined | null

function buildUrl(
 pathname: string,
 currentSearchParams: URLSearchParams,
 updates: Record<string, UrlValue>,
): string {
 const params = new URLSearchParams(currentSearchParams.toString())
 for (const [key, value] of Object.entries(updates)) {
 if (value === null || value === undefined || value === '') {
 params.delete(key)
 } else {
 params.set(key, String(value))
 }
 }
 const qs = params.toString()
 return qs ? `${pathname}?${qs}` : pathname
}

export function useCrmTable<T>({
 queryKey,
 fetchPage,
 defaultPageSize = 20,
 scope: initialScope,
}: UseCrmTableParams<T>): UseCrmTableReturn<T> {
 const router = useRouter()
 const pathname = usePathname()
 const searchParams = useSearchParams()

 const page = parsePositiveInt(searchParams.get('page'), 1)
 const pageSize = parsePositiveInt(searchParams.get('pageSize'), defaultPageSize)
 const sortBy = searchParams.get('sortBy') ?? undefined
 const sortOrder = parseSortOrder(searchParams.get('sortOrder'))
 const keyword = searchParams.get('keyword') ?? ''
 const filters = useMemo(
 () => parseFilters(searchParams.get('filters')),
 [searchParams],
 )
 const scopeFromUrl = parseScope(searchParams.get('scope'))
 const scope = scopeFromUrl ?? initialScope

 const writeUrl = useCallback(
 (updates: Record<string, UrlValue>) => {
 const url = buildUrl(pathname, searchParams, updates)
 router.replace(url, { scroll: false })
 },
 [pathname, searchParams, router],
 )

 const setPage = useCallback(
 (next: number) => writeUrl({ page: next === 1 ? null : next }),
 [writeUrl],
 )
 const setPageSize = useCallback(
 (next: number) => writeUrl({ pageSize: next === defaultPageSize ? null : next }),
 [writeUrl, defaultPageSize],
 )
 const setKeyword = useCallback(
 (next: string) => writeUrl({ keyword: next || null }),
 [writeUrl],
 )
 const setSort = useCallback(
 (nextBy: string | undefined, nextOrder: CrmSortOrder | undefined) => {
 writeUrl({ sortBy: nextBy ?? null, sortOrder: nextOrder ?? null })
 },
 [writeUrl],
 )
 const toggleSort = useCallback(
 (col: string) => {
 if (sortBy !== col) {
 writeUrl({ sortBy: col, sortOrder: 'asc' })
 } else if (sortOrder === 'asc') {
 writeUrl({ sortOrder: 'desc' })
 } else if (sortOrder === 'desc') {
 writeUrl({ sortBy: null, sortOrder: null })
 }
 },
 [sortBy, sortOrder, writeUrl],
 )
 const setFilters = useCallback(
 (next: FilterCondition[]) => {
 const value = next.length === 0 ? null : JSON.stringify(next)
 writeUrl({ filters: value })
 },
 [writeUrl],
 )
 const setScope = useCallback(
 (next: 'mine' | 'all' | undefined) => writeUrl({ scope: next ?? null }),
 [writeUrl],
 )
 const reset = useCallback(() => {
 router.replace(pathname, { scroll: false })
 }, [router, pathname])

 const [data, setData] = useState<T[] | undefined>(undefined)
 const [total, setTotal] = useState(0)
 const [loading, setLoading] = useState(false)
 const [error, setError] = useState<Error | null>(null)
 const reqIdRef = useRef(0)

 const runFetch = useCallback(async () => {
 const reqId = ++reqIdRef.current
 setLoading(true)
 setError(null)
 try {
 const result = await fetchPage({
 page,
 pageSize,
 sortBy,
 sortOrder,
 keyword: keyword || undefined,
 filters,
 scope: scope ?? undefined,
 })
 if (reqId !== reqIdRef.current) return
 setData(result.items)
 setTotal(result.total)
 } catch (e) {
 if (reqId !== reqIdRef.current) return
 setError(e instanceof Error ? e : new Error(String(e)))
 } finally {
 if (reqId === reqIdRef.current) setLoading(false)
 }
 }, [fetchPage, page, pageSize, sortBy, sortOrder, keyword, filters, scope])

 useEffect(() => {
 void runFetch()
 }, [runFetch])

 const refresh = useCallback(async () => {
 await runFetch()
 }, [runFetch])

 return useMemo(
 () => ({
 data,
 total,
 loading,
 error,
 page,
 pageSize,
 sortBy,
 sortOrder,
 keyword,
 filters,
 scope,
 setPage,
 setPageSize,
 setKeyword,
 setSort,
 toggleSort,
 setFilters,
 setScope,
 reset,
 refresh,
 }),
 [
 data,
 total,
 loading,
 error,
 page,
 pageSize,
 sortBy,
 sortOrder,
 keyword,
 filters,
 scope,
 setPage,
 setPageSize,
 setKeyword,
 setSort,
 toggleSort,
 setFilters,
 setScope,
 reset,
 refresh,
 ],
 )
}