import { ProfileInfoSkeleton } from './components/profile-skeletons'

export default function Loading() {
  return (
    <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-6">
      <div className="rounded-none border border-term-border bg-term-panel p-6">
        <ProfileInfoSkeleton />
      </div>
    </div>
  )
}
