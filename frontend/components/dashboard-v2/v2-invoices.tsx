"use client";

import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Table,
	TableBody,
	TableCaption,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { V2Card } from "@/components/dashboard-v2/v2-card";

const invoices = [
	{
		id: "1045",
		customer: "Northwind Labs",
		amount: "$2,400.00",
		status: "Paid",
	},
	{
		id: "1044",
		customer: "Blue River Co.",
		amount: "$890.00",
		status: "Pending",
	},
	{
		id: "1043",
		customer: "Oak Street Studio",
		amount: "$5,120.00",
		status: "Paid",
	},
	{
		id: "1042",
		customer: "Harbor Freight LLC",
		amount: "$310.50",
		status: "Overdue",
	},
] as const;

export function V2Invoices() {
	return (
		<V2Card className="relative gap-0 md:col-span-2">
			<CardHeader className="border-b">
				<CardTitle className="text-base">Recent invoices</CardTitle>
				<CardDescription>Open amounts and payment status.</CardDescription>
			</CardHeader>
			<CardContent className="[mask-image:linear-gradient(to_bottom,black_50%,transparent)] px-0">
				<Table>
					<TableCaption className="sr-only">
						Recent invoices with customer, amount, and status.
					</TableCaption>
					<TableHeader>
						<TableRow>
							<TableHead className="ps-6">Customer</TableHead>
							<TableHead>Invoice</TableHead>
							<TableHead className="pe-6 text-right tabular-nums">
								Amount
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{invoices.map((inv) => (
							<TableRow className="h-12" key={inv.id}>
								<TableCell className="max-w-40 truncate ps-6 font-medium">
									{inv.customer}
								</TableCell>
								<TableCell className="text-muted-foreground tabular-nums">
									#{inv.id}
								</TableCell>
								<TableCell className="pe-6 text-right tabular-nums">
									{inv.amount}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</CardContent>
			<div className="[mask-image:linear-gradient(to_top,black_30%,transparent)] absolute inset-x-0 bottom-0 flex h-1/5 items-center justify-center bg-background">
				<Button asChild className="relative" variant="ghost">
					<a href="/#">
						View All
						<ArrowRight aria-hidden="true" className="size-4" />
					</a>
				</Button>
			</div>
		</V2Card>
	);
}
