declare module 'react-syntax-highlighter' {
  import { ComponentType } from 'react'
  
  export interface SyntaxHighlighterProps {
    children: string
    language?: string
    style?: { [key: string]: React.CSSProperties }
    showLineNumbers?: boolean
    customStyle?: React.CSSProperties
    lineNumberStyle?: React.CSSProperties
    [key: string]: any
  }

  export const Prism: ComponentType<SyntaxHighlighterProps>
  export const PrismLight: ComponentType<SyntaxHighlighterProps>
  export const Light: ComponentType<SyntaxHighlighterProps>
  export const LightAsync: ComponentType<SyntaxHighlighterProps>
  export const PrismAsync: ComponentType<SyntaxHighlighterProps>
  export const PrismAsyncLight: ComponentType<SyntaxHighlighterProps>
  export default Prism
}

declare module 'react-syntax-highlighter/dist/esm/styles/prism' {
  export const oneDark: { [key: string]: React.CSSProperties }
  export const oneLight: { [key: string]: React.CSSProperties }
  // Add other common themes as needed
}