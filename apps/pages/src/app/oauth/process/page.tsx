'use client';

import { JSX, useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function Process(): JSX.Element {
  const router = useRouter();

  const handleFragments = async () => {
    const location =
      typeof window !== 'undefined' ? window.location : undefined;
    const hash = location?.hash;
    if (hash !== undefined) {
      const fragment = new URLSearchParams(hash.replace(/^#?\/?/, ''));
      const accessToken = fragment.get('id_token')?.toString();
      const idToken = fragment.get('id_token')?.toString();
      const refreshToken = fragment.get('refresh_token')?.toString();

      const expiresIn = fragment.get('expires_in')?.toString();
      const state = fragment.get('state')?.toString();
      const tokenType = fragment.get('token_type')?.toString();

      const parms = Object.entries({
        access_token: accessToken,
        id_token: idToken,
        expires_in: expiresIn,
        refresh_token: refreshToken,
        state,
        token_type: tokenType,
      })
        .map((entry) => `${entry[0]}=${entry[1]}`)
        .reduce((acc, cur) => `${acc}&${cur}`);

      console.log(`/oauth/complete?${parms}`);

      return router.push(`/oauth/complete?${parms}`);
    }
    return router.push('/oauth/device/activate');
  };

  useEffect(() => {
    handleFragments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <main />;
}
