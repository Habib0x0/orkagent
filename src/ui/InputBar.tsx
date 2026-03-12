import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

interface Props {
  agentName: string;
  onSubmit: (text: string) => void;
}

export default function InputBar({ agentName, onSubmit }: Props) {
  const [value, setValue] = useState('');

  useInput((input, key) => {
    if (key.return) {
      if (value.trim()) {
        onSubmit(value);
      }
      setValue('');
      return;
    }

    if (key.backspace || key.delete) {
      setValue((prev) => prev.slice(0, -1));
      return;
    }

    // ignore non-printable control sequences
    if (input && !key.ctrl && !key.meta) {
      setValue((prev) => prev + input);
    }
  });

  return (
    <Box flexDirection="row" borderStyle="single" borderColor="cyan" paddingX={1}>
      <Text color="cyan">[{agentName}] {'>'} </Text>
      <Text>{value}</Text>
      <Text color="cyan">_</Text>
    </Box>
  );
}
