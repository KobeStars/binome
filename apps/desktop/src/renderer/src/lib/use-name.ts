import { useEffect, useState } from 'react';
import { send } from './engine.ts';

/**
 * Champ prénom : suit le nom du moteur tant qu'on ne l'a pas touché,
 * et ne l'envoie que s'il a vraiment changé.
 */
export function useNameField(current: string) {
  const [value, setValue] = useState(current);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) setValue(current);
  }, [current, dirty]);

  const commit = () => {
    const name = value.trim();
    if (dirty && name && name !== current) send({ cmd: 'setName', name });
    setDirty(false);
  };

  const onChange = (v: string) => {
    setValue(v);
    setDirty(true);
  };

  return { value, onChange, commit };
}
