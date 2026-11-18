'use client';

import { useEffect, useState, type ReactNode } from 'react';

/** Greets by the visitor's own clock, so it is right in any time zone. */
export function Greeting({ name }: { name: string }) {
  const [part, setPart] = useState('Welcome back');
  useEffect(() => {
    const hour = new Date().getHours();
    setPart(hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening');
  }, []);
  return (
    <h1>
      {part}, {name}.
    </h1>
  );
}

export function PageHead({ crumbs, title, sub, children }: { crumbs: string; title: ReactNode; sub?: string; children?: ReactNode }) {
  return (
    <>
      <p className="crumbs">{crumbs}</p>
      <div className="page-head">
        <div>
          {typeof title === 'string' ? <h1>{title}</h1> : title}
          {sub && <p className="sub">{sub}</p>}
        </div>
        {children && <div className="toolbar">{children}</div>}
      </div>
    </>
  );
}
