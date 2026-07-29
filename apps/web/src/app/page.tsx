import { redirect } from 'next/navigation';

const DEFAULT_ROSTER = '11111111-1111-4111-8111-000000000301';

export default function Home(): never {
  redirect(`/rosters/${DEFAULT_ROSTER}`);
}
