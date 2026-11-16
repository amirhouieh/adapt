"use client"

import { useState } from "react"

export function InstallCommand({ command = "npm i adapt-memory" }: { command?: string }) {
	const [copied, setCopied] = useState(false)

	const handleCopy = () => {
		navigator.clipboard.writeText(command)
		setCopied(true)
		setTimeout(() => setCopied(false), 1500)
	}

	return (
		<button
			type="button"
			onClick={handleCopy}
			className="group flex items-center justify-center gap-3 py-2.5 w-full cursor-pointer text-sm"
		>
			<span className="text-fd-muted-foreground select-none">$</span>
			<code className="text-fd-foreground">{command}</code>
			<span className="ml-auto text-fd-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity text-xs">
				{copied ? "copied!" : "copy"}
			</span>
		</button>
	)
}
