import React, { useEffect, useState, useRef, use } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useSearchParams } from 'react-router-dom';

import {Editor, useMonaco} from '@monaco-editor/react';

export const SimpleEditor = ({
  id,
  value,
  onChange,
  onInput,
  is_readonly,
  language,
  theme,
  isDebuggable,
  highlightWord,
  breakpoints,
  onBreakpointsChange,
  status
}) => {
  useEffect(() => {highlightCurrent(highlightWord); console.log("Highlight word updated")}, [highlightWord]);
  useEffect(() => {console.log("Status updated"); highlightCurrent(highlightWord)}, [status]);


  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  const breakpointsDecorationsRef = useRef([]);
  const debugDecorationsRef = useRef([]);

  let previousBreakpoints = [];
  let words = [];

  // ---- notify parent of current breakpoints (derived from decoration IDs) ----
  const notifyParent = () => {
    const model = editorRef.current.getModel();
    if (!model) return;
    const lines = Array.from(
      new Set(
        breakpointsDecorationsRef.current
          .map(id => model.getDecorationRange(id)?.startLineNumber)
          .filter((n) => typeof n === "number")
      )
    ).sort((a, b) => a - b);
    const same =
      lines.length === previousBreakpoints.length &&
      lines.every((v, i) => v === previousBreakpoints[i]);

    if( !same){
      onBreakpointsChange?.(lines);
      previousBreakpoints = lines;
    }
  };

  // ---- helper (define it BEFORE using it) ----
  function makeBpDescriptor(rangeOrRangeLike) {
    // Accept either a real monaco.Range or a plain object with startLineNumber...
    const range =
      rangeOrRangeLike instanceof monaco.Range
        ? rangeOrRangeLike
        : new monaco.Range(
            rangeOrRangeLike.startLineNumber,
            rangeOrRangeLike.startColumn || 1,
            rangeOrRangeLike.endLineNumber,
            rangeOrRangeLike.endColumn || 1
          );

    return {
      range,
      options: {
        isWholeLine: true,
        glyphMarginClassName: "myBreakpoint" // change to your CSS class
      }
    };
  }

  const handleEditorDidMount = (editor, monaco) => {
    if( isDebuggable !== true ) return;
    editorRef.current = editor;
    monacoRef.current = monaco;

    // Listen for gutter clicks
    editor.onMouseDown((e) => {
      if( isDebuggable !== true ) return;
      if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
        const model = editor.getModel(); // Check if model is available
        if (!model) return;

        const line = e.target.position.lineNumber;

        // Build descriptors for current decorations (skip any stale IDs)
        const currentDescriptors = breakpointsDecorationsRef.current
          .map(id => {
            const r = model.getDecorationRange(id);
            return r ? makeBpDescriptor(r) : null;
          }).filter(Boolean);

        // Find whether there is an existing decoration on that exact startLineNumber
        const existingIndex = currentDescriptors.findIndex(d => d.range.startLineNumber === line);

        // Build desired descriptors after toggle (remove existing or add new)
        let newDescriptors;
        let startLines = new Set(currentDescriptors.map(d => d.range.startLineNumber));
        if (existingIndex >= 0) {
          // remove the descriptor at startLineNumber
          newDescriptors = currentDescriptors.filter(d => d.range.startLineNumber !== line );
        } else {
          // add new breakpoint descriptor
          newDescriptors = [
            ...currentDescriptors,
            makeBpDescriptor(new monaco.Range(line, 1, line, 1))
          ];
        }

        // Update decorations in the editor and keep new IDs
        breakpointsDecorationsRef.current = editor.deltaDecorations(
          breakpointsDecorationsRef.current,
          newDescriptors
        );

        // Notify parent with fresh list of breakpoints
        notifyParent();
      }
    });

    const model = editorRef.current.getModel();
    const contentListener = model?.onDidChangeContent(() => {
      // just recompute lines from decoration ids
      notifyParent();
    });

    let initialDescriptors = [];
    for( let line of breakpoints ) {
      initialDescriptors.push(makeBpDescriptor(new monaco.Range(line, 1, line, 1)));
    }
    // Update decorations in the editor and keep new IDs
    breakpointsDecorationsRef.current = editor.deltaDecorations(
      breakpointsDecorationsRef.current,
      initialDescriptors
    );

    notifyParent();
    // updateDebugLine();
  };

  // Parse model into space-separated commands
  function parseCommands() {
    if (!editorRef.current) return [];
    const model = editorRef.current.getModel();

    let result = [];
    for (let line = 1; line <= model.getLineCount(); line++) {
      const text = model.getLineContent(line);

      // Split by spaces, filter out empty tokens
      let offset = 0;
      text.split(/\s+/).forEach(word => {
        if (word) {
          // find where this word starts
          let startColumn = text.indexOf(word, offset) + 1;
          let endColumn = startColumn + word.length;
          offset = startColumn + word.length;

          result.push({
            word,
            range: new monaco.Range(line, startColumn, line, endColumn),
          });
        }
      });
    }
    return result;
  }

  // Highlight current command
  function highlightCurrent(currentIndex) {
    words = parseCommands();
    if( !words.length ) return;
    console.log("Highlighting current command:", currentIndex, status);

    // Clear old highlight
    debugDecorationsRef.current = editorRef.current.deltaDecorations(debugDecorationsRef.current, []);

    if (currentIndex <= 0) return;
    // Highlight new command
    if (currentIndex <= words.length && status != "error" && status != "success") {
      const current = words[currentIndex-1];
      debugDecorationsRef.current = editorRef.current.deltaDecorations(debugDecorationsRef.current, [
        {
          range: current.range,
          options: {
            className: "debugCommandHighlight",
          },
        },
      ]);

      // Scroll into view
      editorRef.current.revealRangeInCenter(current.range);
    } else {
      console.log("Highlighting last line");
      currentIndex = currentIndex > words.length - 1? words.length - 1 : currentIndex;
      let lineNumber = words[currentIndex].range.endLineNumber;
      let model = editorRef.current.getModel();
      let className = status == "success" ? "successCommandHighlight" : "errorCommandHighlight";
      debugDecorationsRef.current = editorRef.current.deltaDecorations(debugDecorationsRef.current, [
        {
          range: new monaco.Range(lineNumber, 1, lineNumber, 1),
          options: {
            isWholeLine: true,
            className: className, // style for the rest of the line
          },
        },
      ]);
      editorRef.current.revealLineInCenter(lineNumber);
    }
  }

  // Step to next command
  function stepNext() {
    if (!words.length) return;
    currentIndex = (currentIndex + 1) % words.length;
    highlightCurrent();
  }

  return (
    <Editor
      height="400px"
      theme={theme || "vs-dark"}
      id={id}
      language={language || "plaintext"}
      value={value}
      onChange={onChange}
      onInput={onInput}
      options={{
        readOnly: is_readonly,
        domReadOnly: is_readonly,
        minimap: { enabled: false },
        glyphMargin: { isDebuggable }, // needed for gutter icons
      }}
      onMount={handleEditorDidMount}
    />
  );
};