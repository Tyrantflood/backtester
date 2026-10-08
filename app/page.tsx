import Workspace from "@/components/Workspace";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Backtester</h1>
      <Workspace />
    </main>
  );
}
