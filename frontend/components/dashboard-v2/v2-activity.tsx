import { CreditCard, FileText, Rocket, UserPlus } from "lucide-react";

import {
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { V2Card } from "@/components/dashboard-v2/v2-card";

const items = [
	{
		title: "Invoice #1045 marked paid",
		time: "About 2 hours ago",
		icon: <CreditCard aria-hidden="true" className="size-4" />,
	},
	{
		title: "Jordan joined the team",
		time: "This morning",
		icon: <UserPlus aria-hidden="true" className="size-4" />,
	},
	{
		title: "Weekly summary exported",
		time: "Yesterday",
		icon: <FileText aria-hidden="true" className="size-4" />,
	},
	{
		title: "Dashboard v2 shipped to prod",
		time: "2 days ago",
		icon: <Rocket aria-hidden="true" className="size-4" />,
	},
] as const;

export function V2Activity() {
	return (
		<V2Card className="gap-0">
			<CardHeader className="border-b">
				<CardTitle>Activity</CardTitle>
				<CardDescription>Latest updates in your workspace.</CardDescription>
			</CardHeader>
			<CardContent className="px-0">
				<ul className="flex flex-col divide-y divide-border">
					{items.map((item) => (
						<li className="flex h-16 items-center gap-3 px-6" key={item.title}>
							<span
								aria-hidden="true"
								className="flex size-10 shrink-0 items-center justify-center [&_svg]:size-4"
							>
								{item.icon}
							</span>
							<div className="min-w-0 flex-1 space-y-1">
								<p className="line-clamp-1 text-pretty text-foreground text-sm leading-snug">
									{item.title}
								</p>
								<p className="text-muted-foreground text-xs">{item.time}</p>
							</div>
						</li>
					))}
				</ul>
			</CardContent>
		</V2Card>
	);
}
