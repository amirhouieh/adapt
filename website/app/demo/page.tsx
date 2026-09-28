"use client"

import { DemoOrchestrator } from "@/components/demo/demo-orchestrator"

export default function DemoPage() {
	if (process.env.NEXT_PUBLIC_GITHUB_PAGES === "true") {
		return (
			<div className="flex min-h-screen items-center justify-center px-6 text-center">
				<div className="max-w-md space-y-3">
					<h1 className="text-lg">The interactive demo needs a server runtime.</h1>
					<p className="text-sm text-fd-muted-foreground">
						This GitHub Pages build hosts Adapt's project site and documentation.
						 Clone the repository to run the demo locally.
					</p>
					<a className="text-sm underline" href="https://github.com/amirhouieh/adapt">
						View the repository
					</a>
				</div>
			</div>
		)
	}

	return <DemoOrchestrator />
}
