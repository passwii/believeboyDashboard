import { ArrowRight, CircleCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { V2Card } from "@/components/dashboard-v2/v2-card";

export function V2Billing() {
	return (
		<V2Card className="gap-0">
			<CardHeader className="border-b">
				<CardTitle className="text-balance text-base">Billing health</CardTitle>
				<CardDescription className="text-pretty">
					Nothing urgent needs your attention.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex h-full items-center px-0">
				<Empty>
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<CircleCheck aria-hidden="true" className="size-6" />
						</EmptyMedia>
						<EmptyTitle>You&apos;re caught up.</EmptyTitle>
						<EmptyDescription className="text-xs">
							Balances and payouts look fine. nothing overdue in this snapshot.
						</EmptyDescription>
					</EmptyHeader>
					<EmptyContent>
						<Button asChild variant="ghost">
							<a href="/#">
								Review open invoices
								<ArrowRight aria-hidden="true" className="size-4" />
							</a>
						</Button>
					</EmptyContent>
				</Empty>
			</CardContent>
		</V2Card>
	);
}
