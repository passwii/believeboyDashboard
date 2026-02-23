import { MetricCards } from '@/components/dashboard/metric-cards'
import { VisitorsChart } from '@/components/dashboard/charts'
import { DataTable } from '@/components/dashboard/data-table'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground">
          Welcome back! Here is an overview of your account.
        </p>
      </div>
      
      <MetricCards />
      
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-7">
        <VisitorsChart />
        <Card className="col-span-3">
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
            <CardDescription>
              Your latest actions and updates
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center gap-4">
                <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center">
                  <span className="text-sm font-medium">JD</span>
                </div>
                <div className="flex-1 space-y-1">
                  <p className="text-sm font-medium leading-none">John Doe</p>
                  <p className="text-sm text-muted-foreground">
                    Created a new document
                  </p>
                </div>
                <div className="text-sm text-muted-foreground">2m ago</div>
              </div>
              <div className="flex items-center gap-4">
                <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center">
                  <span className="text-sm font-medium">JS</span>
                </div>
                <div className="flex-1 space-y-1">
                  <p className="text-sm font-medium leading-none">Jane Smith</p>
                  <p className="text-sm text-muted-foreground">
                    Updated the API documentation
                  </p>
                </div>
                <div className="text-sm text-muted-foreground">15m ago</div>
              </div>
              <div className="flex items-center gap-4">
                <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center">
                  <span className="text-sm font-medium">BJ</span>
                </div>
                <div className="flex-1 space-y-1">
                  <p className="text-sm font-medium leading-none">Bob Johnson</p>
                  <p className="text-sm text-muted-foreground">
                    Completed review of PR #42
                  </p>
                </div>
                <div className="text-sm text-muted-foreground">1h ago</div>
              </div>
              <div className="flex items-center gap-4">
                <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center">
                  <span className="text-sm font-medium">AB</span>
                </div>
                <div className="flex-1 space-y-1">
                  <p className="text-sm font-medium leading-none">Alice Brown</p>
                  <p className="text-sm text-muted-foreground">
                    Deployed to production
                  </p>
                </div>
                <div className="text-sm text-muted-foreground">3h ago</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
      
      <Card>
        <CardHeader>
          <CardTitle>Documents</CardTitle>
          <CardDescription>
            A list of your recent documents and their status.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable />
        </CardContent>
      </Card>
    </div>
  )
}
