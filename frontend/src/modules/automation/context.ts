import { createContext } from 'react'
import type { NodeType } from '@/api/automation'

export interface BuilderView {
  summary: (id: string, type: NodeType, data: Record<string, unknown>) => string
  issues: Record<string, string[]>
  stats: Record<string, Record<string, number>> | null
  readOnly: boolean
}

export const BuilderContext = createContext<BuilderView>({ summary: () => '', issues: {}, stats: null, readOnly: false })
