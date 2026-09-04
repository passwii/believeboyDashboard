export type FieldType =
  | 'text'
  | 'number'
  | 'select'
  | 'multiselect'
  | 'date'
  | 'textarea'
  | 'phone'
  | 'email'
  | 'url'

export interface FieldDefinition {
  key: string
  label: string
  type: FieldType
  required?: boolean
  options?: Array<{ label: string; value: string }>
  placeholder?: string
  group?: 'basic' | 'contact' | 'business' | 'system'
}
