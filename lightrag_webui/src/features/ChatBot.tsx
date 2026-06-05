import { useState, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  SendIcon,
  EraserIcon,
  MessageSquareIcon,
  SettingsIcon,
  SparklesIcon,
  CopyIcon,
  InfoIcon
} from 'lucide-react'

import Button from '@/components/ui/Button'
import Input from '@/components/ui/Input'
import Textarea from '@/components/ui/Textarea'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/Select'
import { ChatMessage, MessageWithError } from '@/components/retrieval/ChatMessage'
import { queryText, queryTextStream } from '@/api/lightrag'
import { errorMessage, cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings'
import { copyToClipboard } from '@/utils/clipboard'
import type { QueryMode } from '@/api/lightrag'

const generateUniqueId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `chat-id-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
}

const detectLatexCompleteness = (content: string): boolean => {
  const blockLatexMatches = content.match(/\$\$/g) || []
  const hasUnclosedBlock = blockLatexMatches.length % 2 !== 0

  const contentWithoutBlocks = content.replace(/\$\$[\s\S]*?\$\$/g, '')
  const inlineLatexMatches = contentWithoutBlocks.match(/(?<!\$)\$(?!\$)/g) || []
  const hasUnclosedInline = inlineLatexMatches.length % 2 !== 0

  return !hasUnclosedBlock && !hasUnclosedInline
}

const parseCOTContent = (content: string) => {
  const thinkStartTag = '<think>'
  const thinkEndTag = '</think>'

  const startMatches: number[] = []
  const endMatches: number[] = []

  let startIndex = 0
  while ((startIndex = content.indexOf(thinkStartTag, startIndex)) !== -1) {
    startMatches.push(startIndex)
    startIndex += thinkStartTag.length
  }

  let endIndex = 0
  while ((endIndex = content.indexOf(thinkEndTag, endIndex)) !== -1) {
    endMatches.push(endIndex)
    endIndex += thinkEndTag.length
  }

  const hasThinkStart = startMatches.length > 0
  const hasThinkEnd = endMatches.length > 0
  const isThinking = hasThinkStart && (startMatches.length > endMatches.length)

  let thinkingContent = ''
  let displayContent = content

  if (hasThinkStart) {
    if (hasThinkEnd && startMatches.length === endMatches.length) {
      const lastStartIndex = startMatches[startMatches.length - 1]
      const lastEndIndex = endMatches[endMatches.length - 1]

      if (lastEndIndex > lastStartIndex) {
        thinkingContent = content.substring(
          lastStartIndex + thinkStartTag.length,
          lastEndIndex
        ).trim()
        displayContent = content.substring(lastEndIndex + thinkEndTag.length).trim()
      }
    } else if (isThinking) {
      const lastStartIndex = startMatches[startMatches.length - 1]
      thinkingContent = content.substring(lastStartIndex + thinkStartTag.length)
      displayContent = ''
    }
  }

  return {
    isThinking,
    thinkingContent,
    displayContent,
    hasValidThinkBlock: hasThinkStart && hasThinkEnd && startMatches.length === endMatches.length
  }
}

export default function ChatBot() {
  const { t } = useTranslation()
  const currentTab = useSettingsStore.use.currentTab()
  const isChatTabActive = currentTab === 'chat'

  // Persist chat message history to localStorage for convenience
  const [messages, setMessages] = useState<MessageWithError[]>(() => {
    try {
      const saved = localStorage.getItem('LIGHTRAG-CHAT-HISTORY')
      return saved ? JSON.parse(saved) : []
    } catch {
      return []
    }
  })

  const [inputValue, setInputValue] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [chatSettings, setChatSettings] = useState(() => {
    return {
      mode: 'mix' as QueryMode,
      historyTurns: 5,
      systemInstruction: ''
    }
  })

  const [showSettings, setShowSettings] = useState(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null)
  const thinkingStartTime = useRef<number | null>(null)
  const thinkingProcessed = useRef(false)
  const shouldFollowScrollRef = useRef(true)

  // Save history to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('LIGHTRAG-CHAT-HISTORY', JSON.stringify(messages))
    } catch (e) {
      console.error('Failed to save chat history:', e)
    }
  }, [messages])

  // Scroll to bottom helper
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (messagesEndRef.current) {
        messagesEndRef.current.scrollIntoView({ behavior: 'smooth' })
      }
    })
  }, [])

  // Auto-scroll logic during loading
  useEffect(() => {
    if (isLoading && shouldFollowScrollRef.current) {
      scrollToBottom()
    }
  }, [messages, isLoading, scrollToBottom])

  const adjustTextareaHeight = useCallback((element: HTMLTextAreaElement) => {
    requestAnimationFrame(() => {
      element.style.height = 'auto'
      element.style.height = Math.min(element.scrollHeight, 120) + 'px'
    })
  }, [])

  // Quick suggestions trigger
  const handleQuickPrompt = useCallback((promptText: string) => {
    setInputValue(promptText)
    setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus()
      }
    }, 50)
  }, [])

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      if (!inputValue.trim() || isLoading) return

      if (inputValue.trim().length < 3) {
        toast.error(t('retrievePanel.retrieval.queryTooShort', 'Query must be at least 3 characters long'))
        return
      }

      const userQuery = inputValue
      setInputValue('')
      setIsLoading(true)
      shouldFollowScrollRef.current = true

      // Reset height of text input if it is a textarea
      if (inputRef.current) {
        inputRef.current.style.height = '40px'
      }

      // Generate message records
      const userMessage: MessageWithError = {
        id: generateUniqueId(),
        content: userQuery,
        role: 'user'
      }

      const assistantMessage: MessageWithError = {
        id: generateUniqueId(),
        content: '',
        role: 'assistant',
        mermaidRendered: false,
        latexRendered: false,
        thinkingTime: null,
        isThinking: false
      }

      const prevMessages = [...messages]
      setMessages([...prevMessages, userMessage, assistantMessage])

      // Setup stream update callback
      const updateAssistantMessage = (chunk: string, isError?: boolean) => {
        assistantMessage.content += chunk

        if (assistantMessage.content.includes('<think>') && !thinkingStartTime.current) {
          thinkingStartTime.current = Date.now()
        }

        const cotResult = parseCOTContent(assistantMessage.content)
        assistantMessage.isThinking = cotResult.isThinking

        if (cotResult.hasValidThinkBlock && !thinkingProcessed.current) {
          if (thinkingStartTime.current) {
            const duration = (Date.now() - thinkingStartTime.current) / 1000
            assistantMessage.thinkingTime = parseFloat(duration.toFixed(2))
          }
          thinkingProcessed.current = true
        }

        assistantMessage.thinkingContent = cotResult.thinkingContent
        assistantMessage.displayContent = cotResult.isThinking ? '' : (cotResult.displayContent || assistantMessage.content)

        // Detect mermaid
        const mermaidBlockRegex = /```mermaid\s+([\s\S]+?)```/g
        let mermaidRendered = false
        let match
        while ((match = mermaidBlockRegex.exec(assistantMessage.content)) !== null) {
          if (match[1] && match[1].trim().length > 10) {
            mermaidRendered = true
            break
          }
        }
        assistantMessage.mermaidRendered = mermaidRendered

        // LaTeX detect
        assistantMessage.latexRendered = detectLatexCompleteness(assistantMessage.content)

        setMessages((prev) => {
          const newMessages = [...prev]
          const lastMessage = newMessages[newMessages.length - 1]
          if (lastMessage && lastMessage.id === assistantMessage.id) {
            Object.assign(lastMessage, {
              content: assistantMessage.content,
              thinkingContent: assistantMessage.thinkingContent,
              displayContent: assistantMessage.displayContent,
              isThinking: assistantMessage.isThinking,
              isError: isError,
              mermaidRendered: assistantMessage.mermaidRendered,
              latexRendered: assistantMessage.latexRendered,
              thinkingTime: assistantMessage.thinkingTime
            })
          }
          return newMessages
        })
      }

      // Build parameters using our settings
      const state = useSettingsStore.getState()
      const effectiveHistoryTurns = chatSettings.historyTurns || 0

      // Map conversation history
      const conversationHistory = effectiveHistoryTurns > 0
        ? prevMessages
          .filter((m) => !m.isError)
          .slice(-effectiveHistoryTurns * 2)
          .map((m) => ({ role: m.role, content: m.content }))
        : []

      const queryParams = {
        ...state.querySettings,
        query: userQuery,
        mode: chatSettings.mode,
        conversation_history: conversationHistory,
        user_prompt: chatSettings.systemInstruction.trim() || undefined
      }

      try {
        if (state.querySettings.stream) {
          let streamError = ''
          await queryTextStream(queryParams, updateAssistantMessage, (err) => {
            streamError += err
          })
          if (streamError) {
            updateAssistantMessage(
              assistantMessage.content ? `${assistantMessage.content}\n${streamError}` : streamError,
              true
            )
          }
        } else {
          const res = await queryText(queryParams)
          updateAssistantMessage(res.response)
        }
      } catch (err) {
        updateAssistantMessage(`Error: ${errorMessage(err)}`, true)
      } finally {
        setIsLoading(false)
        assistantMessage.isThinking = false
        thinkingStartTime.current = null
        thinkingProcessed.current = false

        // Force scroll at the very end
        scrollToBottom()
      }
    },
    [inputValue, isLoading, messages, chatSettings, scrollToBottom]
  )

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      const target = e.target as HTMLTextAreaElement
      const start = target.selectionStart || 0
      const end = target.selectionEnd || 0
      const newValue = inputValue.slice(0, start) + '\n' + inputValue.slice(end)
      setInputValue(newValue)
      setTimeout(() => {
        target.setSelectionRange(start + 1, start + 1)
        adjustTextareaHeight(target)
      }, 0)
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e as any)
    }
  }, [inputValue, handleSubmit, adjustTextareaHeight])

  const clearMessages = useCallback(() => {
    setMessages([])
    localStorage.removeItem('LIGHTRAG-CHAT-HISTORY')
  }, [])

  const handleCopyMessage = useCallback(async (message: MessageWithError) => {
    const text = message.role === 'user'
      ? message.content
      : (message.displayContent !== undefined ? message.displayContent : message.content)
    const res = await copyToClipboard(text || '')
    if (res.success) {
      toast.success(t('retrievePanel.chatMessage.copySuccess', 'Copied to clipboard'))
    } else {
      toast.error(t('retrievePanel.chatMessage.copyFailed', 'Copy failed'))
    }
  }, [t])

  const allowedModes: { value: QueryMode; label: string }[] = [
    { value: 'mix', label: 'Mix (Hybrid + Naive + Reranker)' },
    { value: 'hybrid', label: 'Hybrid (Local + Global)' },
    { value: 'local', label: 'Local (Entity focus)' },
    { value: 'global', label: 'Global (Summary focus)' },
    { value: 'naive', label: 'Naive (Standard Vector Search)' },
    { value: 'bypass', label: 'Bypass (LLM Chat direct)' }
  ]

  return (
    <div className="flex size-full flex-row overflow-hidden bg-background">
      {/* Central Chat View */}
      <div className="flex flex-1 flex-col overflow-hidden px-4 md:px-8 py-4">
        {/* Chat Header */}
        <div className="flex shrink-0 items-center justify-between border-b pb-3">
          <div className="flex items-center gap-2">
            <MessageSquareIcon className="size-5 text-emerald-500" />
            <h1 className="font-bold text-lg text-foreground">LightRAG AI Chat</h1>
            <span className="rounded bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300 text-xs px-1.5 py-0.5 font-medium">
              Mode: {chatSettings.mode}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowSettings(!showSettings)}
              className={cn(showSettings && 'bg-muted')}
              tooltip={t('chatPanel.settings', 'Conversation Settings')}
            >
              <SettingsIcon className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={clearMessages}
              disabled={messages.length === 0}
            >
              <EraserIcon className="mr-1 size-3.5" />
              {t('retrievePanel.retrieval.clear', 'Clear')}
            </Button>
          </div>
        </div>

        {/* Message Panel */}
        <div
          ref={messagesContainerRef}
          className="flex-1 overflow-y-auto py-4 space-y-4 pr-1"
        >
          {messages.length === 0 ? (
            <div className="flex flex-col h-full items-center justify-center text-center max-w-lg mx-auto">
              <SparklesIcon className="size-12 text-emerald-400 mb-4 animate-pulse" />
              <h2 className="text-xl font-bold text-foreground mb-2">Welcome to LightRAG Chat!</h2>
              <p className="text-muted-foreground text-sm mb-6">
                Ask questions based on your loaded knowledge base. Select your preferred query mode in the settings panel to retrieve matching entities, relations, and text chunks.
              </p>

              {/* Quick suggestions */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 w-full">
                <button
                  onClick={() => handleQuickPrompt("What are the key topics in the uploaded files?")}
                  className="p-3 text-left border rounded-lg hover:bg-muted text-sm text-foreground transition-all cursor-pointer"
                >
                  📝 **Summarize Documents**
                  <p className="text-xs text-muted-foreground mt-1">Get a high-level overview of the ingested content.</p>
                </button>
                <button
                  onClick={() => handleQuickPrompt("List the main entities and their relationships.")}
                  className="p-3 text-left border rounded-lg hover:bg-muted text-sm text-foreground transition-all cursor-pointer"
                >
                  🔗 **Extract Relations**
                  <p className="text-xs text-muted-foreground mt-1">View major entities connected in the Knowledge Graph.</p>
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={cn(
                    "flex items-start gap-3 w-full group",
                    message.role === 'user' ? 'flex-row-reverse' : 'flex-row'
                  )}
                >
                  {/* Avatar */}
                  <div
                    className={cn(
                      "size-8 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 select-none",
                      message.role === 'user'
                        ? 'bg-zinc-800 text-zinc-100 dark:bg-zinc-200 dark:text-zinc-800'
                        : 'bg-emerald-500 text-white'
                    )}
                  >
                    {message.role === 'user' ? 'U' : 'AI'}
                  </div>

                  {/* Message Bubble wrapper */}
                  <div className="max-w-[85%] flex flex-col gap-1">
                    <div className="flex items-center gap-2 px-1">
                      <span className="text-xs text-muted-foreground font-medium">
                        {message.role === 'user' ? 'You' : 'LightRAG Assistant'}
                      </span>
                    </div>

                    <div className="flex items-end gap-2">
                      <ChatMessage message={message} isTabActive={isChatTabActive} />

                      {/* Hover action button */}
                      <Button
                        onClick={() => handleCopyMessage(message)}
                        className="opacity-0 group-hover:opacity-60 transition-opacity size-7 rounded-md"
                        variant="ghost"
                        size="icon"
                        tooltip="Copy message"
                      >
                        <CopyIcon className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Input Form Panel */}
        <form onSubmit={handleSubmit} className="shrink-0 pt-2 border-t flex flex-col gap-2">
          <div className="relative flex items-center gap-2">
            <Textarea
              ref={inputRef as React.RefObject<HTMLTextAreaElement>}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('retrievePanel.retrieval.placeholder', 'Enter your message...')}
              disabled={isLoading}
              rows={1}
              style={{
                resize: 'none',
                height: '42px',
                minHeight: '42px',
                maxHeight: '120px'
              }}
              onInput={(e: React.FormEvent<HTMLTextAreaElement>) => {
                const target = e.target as HTMLTextAreaElement
                adjustTextareaHeight(target)
              }}
              className="flex-1 pr-12 rounded-xl border border-muted bg-primary-foreground focus-visible:ring-1 focus-visible:ring-emerald-400 py-3"
            />
            <Button
              type="submit"
              disabled={!inputValue.trim() || isLoading}
              className={cn(
                "absolute right-2 size-8 rounded-lg !p-0 bg-emerald-500 hover:bg-emerald-600 text-white cursor-pointer transition-transform duration-200 active:scale-95"
              )}
            >
              <SendIcon className="size-4" />
            </Button>
          </div>
          <div className="flex justify-between items-center px-1">
            <span className="text-[10px] text-muted-foreground">
              Press Enter to send, Shift+Enter for new line.
            </span>
            {chatSettings.mode === 'bypass' && (
              <span className="text-[10px] text-amber-500 flex items-center gap-1 font-medium">
                <InfoIcon className="size-3" /> Direct LLM chat (No KG Retrieval)
              </span>
            )}
          </div>
        </form>
      </div>

      {/* Settings Side Draw Panel */}
      {showSettings && (
        <div className="w-80 shrink-0 border-l bg-muted/30 p-4 overflow-y-auto flex flex-col gap-4">
          <h2 className="font-bold text-base text-foreground flex items-center gap-1.5 border-b pb-2">
            <SettingsIcon className="size-4" />
            Chat Configuration
          </h2>

          {/* Mode Selector */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-muted-foreground">Retrieval Mode</label>
            <Select
              value={chatSettings.mode}
              onValueChange={(val) => setChatSettings({ ...chatSettings, mode: val as QueryMode })}
            >
              <SelectTrigger className="h-9 cursor-pointer w-full text-left bg-background">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {allowedModes.map((mode) => (
                    <SelectItem key={mode.value} value={mode.value}>
                      {mode.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              • **Mix**: Combines vectors, entities & reranker (Recommended).<br />
              • **Hybrid**: Query entities and relations.<br />
              • **Local**: Query entity graph.<br />
              • **Global**: Retrieve broad summaries.<br />
              • **Bypass**: Direct LLM dialog.
            </p>
          </div>

          {/* History turns */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-muted-foreground">Context turns history</label>
            <Input
              type="number"
              min={0}
              max={15}
              value={chatSettings.historyTurns}
              onChange={(e) => setChatSettings({ ...chatSettings, historyTurns: parseInt(e.target.value) || 0 })}
              className="bg-background"
            />
            <span className="text-[10px] text-muted-foreground">
              Number of past dialogue turns sent for context memory.
            </span>
          </div>

          {/* System Instructions / AI Persona */}
          <div className="flex flex-col gap-1.5 grow">
            <label className="text-xs font-semibold text-muted-foreground">AI Instructions (System Prompt)</label>
            <Textarea
              value={chatSettings.systemInstruction}
              onChange={(e) => setChatSettings({ ...chatSettings, systemInstruction: e.target.value })}
              placeholder="e.g. You are a tech support helper. Format response in points."
              className="bg-background min-h-[120px] text-xs resize-y grow"
            />
            <span className="text-[10px] text-muted-foreground">
              Overrides target formatting or sets persona rules for the AI.
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
