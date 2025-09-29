import React, { useEffect, useState, useRef, use } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useSearchParams } from 'react-router-dom';

import {Editor, useMonaco} from '@monaco-editor/react';
import {SimpleEditor} from "./SimpleEditor"


/**
 * Bitcoin Script Hex ⇄ ASM Editor
 *
 * NOTE: Removed dependency on `bitcoinjs-lib` to avoid the runtime error
 * "Cannot destructure property 'sha256' ..." that can occur with some
 * browser/bundler environments. This implementation performs ASM ⇄ HEX
 * conversion in pure JS and supports standard opcodes and all PUSH* encodings.
 */

// -------------------- Opcode Tables --------------------
const OPC = {
  OP_0: 0x00,
  OP_FALSE: 0x00,
  OP_TRUE: 0x51,
  OP_PUSHDATA1: 0x4c,
  OP_PUSHDATA2: 0x4d,
  OP_PUSHDATA4: 0x4e,
  OP_1NEGATE: 0x4f,
  OP_RESERVED: 0x50,
  OP_1: 0x51, OP_2: 0x52, OP_3: 0x53, OP_4: 0x54, OP_5: 0x55,
  OP_6: 0x56, OP_7: 0x57, OP_8: 0x58, OP_9: 0x59, OP_10: 0x5a,
  OP_11: 0x5b, OP_12: 0x5c, OP_13: 0x5d, OP_14: 0x5e, OP_15: 0x5f,
  OP_16: 0x60,

  OP_NOP: 0x61,
  OP_IF: 0x63,
  OP_NOTIF: 0x64,
  OP_ELSE: 0x67,
  OP_ENDIF: 0x68,
  OP_VERIFY: 0x69,
  OP_RETURN: 0x6a,
  OP_TOALTSTACK: 0x6b,
  OP_FROMALTSTACK: 0x6c,
  OP_IFDUP: 0x73,
  OP_DEPTH: 0x74,
  OP_DROP: 0x75,
  OP_DUP: 0x76,
  OP_NIP: 0x77,
  OP_OVER: 0x78,
  OP_PICK: 0x79,
  OP_ROLL: 0x7a,
  OP_ROT: 0x7b,
  OP_SWAP: 0x7c,
  OP_TUCK: 0x7d,

  OP_EQUAL: 0x87,
  OP_EQUALVERIFY: 0x88,

  OP_1ADD: 0x8b,
  OP_1SUB: 0x8c,
  OP_NEGATE: 0x8f,
  OP_ABS: 0x90,
  OP_NOT: 0x91,
  OP_0NOTEQUAL: 0x92,
  OP_ADD: 0x93,
  OP_SUB: 0x94,
  OP_BOOLAND: 0x9a,
  OP_BOOLOR: 0x9b,
  OP_NUMEQUAL: 0x9c,
  OP_NUMEQUALVERIFY: 0x9d,
  OP_NUMNOTEQUAL: 0x9e,
  OP_LESSTHAN: 0x9f,
  OP_GREATERTHAN: 0xa0,
  OP_LESSTHANOREQUAL: 0xa1,
  OP_GREATERTHANOREQUAL: 0xa2,
  OP_MIN: 0xa3,
  OP_MAX: 0xa4,
  OP_WITHIN: 0xa5,

  OP_RIPEMD160: 0xa6,
  OP_SHA1: 0xa7,
  OP_SHA256: 0xa8,
  OP_HASH160: 0xa9,
  OP_HASH256: 0xaa,
  OP_CODESEPARATOR: 0xab,
  OP_CHECKSIG: 0xac,
  OP_CHECKSIGVERIFY: 0xad,
  OP_CHECKMULTISIG: 0xae,
  OP_CHECKMULTISIGVERIFY: 0xaf,

  OP_NOP1: 0xb0,
  OP_CHECKLOCKTIMEVERIFY: 0xb1, // a.k.a. OP_NOP2 pre-BIP65
  OP_CHECKSEQUENCEVERIFY: 0xb2,  // a.k.a. OP_NOP3 pre-BIP112
  OP_NOP4: 0xb3,
  OP_NOP5: 0xb4,
  OP_NOP6: 0xb5,
  OP_NOP7: 0xb6,
  OP_NOP8: 0xb7,
  OP_NOP9: 0xb8,
  OP_NOP10: 0xb9,
};

const VAL2NAME = (() => {
  const map = new Map();
  Object.entries(OPC).forEach(([k, v]) => {
    if (!map.has(v)) map.set(v, k);
  });
  return map;
})();

// -------------------- Helpers --------------------
const isHex = (s) => /^[0-9a-fA-F]*$/.test(s);
const cleanHex = (s) => s.replace(/\s+/g, "").toLowerCase();

function hexToBytes(hex) {
  const h = cleanHex(hex);
  if (!isHex(h)) throw new Error("Invalid hex format");
  if (h.length % 2 !== 0) throw new Error("Invalid hex: odd length");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  if (Number.isNaN(out[out.length - 1])) throw new Error("Invalid hex: non-hex char");
  return out;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Encode pushdata prefix for a data buffer of length `len`.
function pushPrefix(len) {
  if (len <= 75) return new Uint8Array([len]);
  if (len <= 0xff) return new Uint8Array([OPC.OP_PUSHDATA1, len]);
  if (len <= 0xffff) return new Uint8Array([OPC.OP_PUSHDATA2, len & 0xff, (len >>> 8) & 0xff]);
  return new Uint8Array([
    OPC.OP_PUSHDATA4,
    len & 0xff,
    (len >>> 8) & 0xff,
    (len >>> 16) & 0xff,
    (len >>> 24) & 0xff,
  ]);
}

// -------------------- ASM → HEX --------------------
function asmToBytes(asm) {
  const tokens = asm
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean);

  const out = [];

  const pushData = (dataBytes) => {
    const pref = pushPrefix(dataBytes.length);
    for (const b of pref) out.push(b);
    for (const b of dataBytes) out.push(b);
  };

  for (let raw of tokens) {
    const t = raw.trim();
    if (!t) continue;

    // <hex> form
    const m = t.match(/^<([0-9a-fA-F]+)>$/);
    if (m) {
      const h = m[1];
      if (!isHex(h) || h.length % 2 !== 0) throw new Error(`Invalid hex data: ${t}`);
      pushData(hexToBytes(h));
      continue;
    }

    // Small integers -1, 0..16
    if (t === "-1") { out.push(OPC.OP_1NEGATE); continue; }
    if (/^(0|1[0-6]?|[1-9])$/.test(t)) {
      const n = Number(t);
      if (n === 0) { out.push(OPC.OP_0); continue; }
      if (n >= 1 && n <= 16) { out.push(OPC.OP_1 + (n - 1)); continue; }
    }

    // OP_* names
    if (/^OP_[A-Z0-9_]+$/.test(t)) {
      const code = OPC[t];
      if (typeof code !== "number") throw new Error(`Unknown opcode: ${t}`);
      out.push(code);
      continue;
    }

    // Bare hex treated as data push
    if (isHex(t)) {
      if (t.length % 2 !== 0) throw new Error(`Odd-length hex: ${t}`);
      pushData(hexToBytes(t));
      continue;
    }

    throw new Error(`Unrecognized token: ${t}`);
  }

  return new Uint8Array(out);
}

function asmToHex(asm) {
  return bytesToHex(asmToBytes(asm));
}

// -------------------- HEX → ASM --------------------
function bytesToAsm(bytes) {
  let i = 0;
  const out = [];
  const readLE = (n) => {
    let v = 0;
    for (let k = 0; k < n; k++) v |= bytes[i + k] << (8 * k);
    i += n;
    return v >>> 0;
  };

  while (i < bytes.length) {
    const op = bytes[i++];

    if (op >= 0x01 && op <= 0x4b) {
      const len = op;
      const data = bytes.slice(i, i + len);
      if (data.length !== len) throw new Error("PUSHDATA truncated");
      i += len;
      out.push(`<${bytesToHex(data)}>`);
      continue;
    }

    if (op === OPC.OP_PUSHDATA1) {
      const len = readLE(1);
      const data = bytes.slice(i, i + len);
      if (data.length !== len) throw new Error("PUSHDATA1 truncated");
      i += len;
      out.push(`<${bytesToHex(data)}>`);
      continue;
    }

    if (op === OPC.OP_PUSHDATA2) {
      const len = readLE(2);
      const data = bytes.slice(i, i + len);
      if (data.length !== len) throw new Error("PUSHDATA2 truncated");
      i += len;
      out.push(`<${bytesToHex(data)}>`);
      continue;
    }

    if (op === OPC.OP_PUSHDATA4) {
      const len = readLE(4);
      const data = bytes.slice(i, i + len);
      if (data.length !== len) throw new Error("PUSHDATA4 truncated");
      i += len;
      out.push(`<${bytesToHex(data)}>`);
      continue;
    }

    // Small ints
    if (op === OPC.OP_0) { out.push("0"); continue; }
    if (op === OPC.OP_1NEGATE) { out.push("-1"); continue; }
    if (op >= OPC.OP_1 && op <= OPC.OP_16) { out.push(String(op - OPC.OP_1 + 1)); continue; }

    const name = VAL2NAME.get(op);
    if (name) out.push(name);
    else throw new Error("Unknown opcode")
  }

  return out.join("\n");
}

function hexToAsm(hex) {
  const bytes = hexToBytes(cleanHex(hex));
  if (bytes.length === 0) return "";
  return bytesToAsm(bytes);
}

// -------------------- ASM->PY --------------------------
function asmToPy(raw_asm) {
  const bytes = asmToBytes(raw_asm);
  const asm = bytesToAsm(bytes);
  let result = "[";
  let terms = asm.split(/\s+/g);
  for (let i = 0; i < terms.length; i++) {
    const term = terms[i].trim();
    if (term.startsWith("<") && term.endsWith(">")) {
      // Hex data
      const hex = term.slice(1, -1);
      terms[i] = `0x${hex}`;
    }
  }
  result += terms.join(", ");
  result += "]";
  return result;
}

// -------------------- Hex->CPP -------------------------
function hexToCpp(hex) {
  const bytes = hexToBytes(cleanHex(hex));
  if (bytes.length === 0) return "";
  return bytesToCpp(bytes);
}

function bytesToCpp(bytes) {
  let result = "{";
  for (let i = 0; i < bytes.length; i++) {
    if( i > 0) result += ", ";
    result += `0x${bytes[i].toString(16).padStart(2, "0")}`;
  }
  result += "}";
  return result;
}

// -------------------- UI Components --------------------
// const SAMPLES = {
//   "P2PKH (legacy)": {
//     asm: "OP_DUP OP_HASH160 <00112233445566778899aabbccddeeff00112233> OP_EQUALVERIFY OP_CHECKSIG",
//     hex: "76a91400112233445566778899aabbccddeeff0011223388ac",
//   },
//   "P2SH (redeem-hash)": {
//     asm: "OP_HASH160 <16b000aabbccddeeff00112233445566778899aa> OP_EQUAL",
//     hex: "a91416b000aabbccddeeff00112233445566778899aa87",
//   },
//   "P2WPKH (v0)": {
//     asm: "0 <00112233445566778899aabbccddeeff00112233>",
//     hex: "001400112233445566778899aabbccddeeff00112233",
//   },
//   "2-of-3 Multisig (bare)": {
//     asm: "2 <02a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1> <03b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2> <02c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3> 3 OP_CHECKMULTISIG",
//   },
// };

function useDebounced(value, delay = 300) {
  const [deb, setDeb] = useState(value);
  React.useEffect(() => {
    const id = setTimeout(() => setDeb(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return deb;
}

const TabButton = ({ id, active, onClick, children }) => {
  const [is_active, setActive] = useState(active);
  useEffect(() => { setActive(active); }, [active]);
  return (
    <button
      id = {id}
      onClick={() => { onClick(); }}
      className={`code-tab-button ${is_active ? "active" : ""}`}
    >
      {children}
    </button>
  );
}

const Card = ({ children, className = "" }) => (
  <div className={`rounded-2xl shadow-sm border border-gray-200 bg-white ${className}`}>
    {children}
  </div>
);

const Header = () => (
  <div className="flex items-center justify-between gap-3 mb-4">
    <div>
      <h1 className="text-2xl font-semibold">Bitcoin Script Editor</h1>
      <p className="text-sm text-gray-500">Live Hex ⇄ ASM with validation (no external libs)</p>
    </div>
  </div>
);

const ServerRequestButton = ({ caption, handleClick }) => {
  return (
    <button onClick={handleClick} className="server-request-button">
      {caption}
    </button>
  );
};

// -------------------- Self-tests --------------------
function normalizeAsm(s) {
  return s.trim().replace(/\s+/g, "\n");
}

// function runSelfTests() {
//   const cases = [];

//   // Provided samples
//   Object.entries(SAMPLES).forEach(([name, v]) => {
//     if (v.hex && v.asm) cases.push({ name: `${name} (asm↔hex)`, asm: v.asm, hex: v.hex });
//   });

//   // Boundary push sizes
//   const mkhex = (n) => bytesToHex(new Uint8Array(n).fill(0xab));
//   const p75 = `<${mkhex(75)}>`; // single-byte length
//   const p76 = `<${mkhex(76)}>`; // PUSHDATA1
//   const p255 = `<${mkhex(255)}>`; // PUSHDATA1
//   const p256 = `<${mkhex(256)}>`; // PUSHDATA2

//   cases.push({ name: "PUSH 75", asm: p75 });
//   cases.push({ name: "PUSH 76", asm: p76 });
//   cases.push({ name: "PUSH 255", asm: p255 });
//   cases.push({ name: "PUSH 256", asm: p256 });

//   // Small integers
//   cases.push({ name: "Small ints", asm: "0 1 2 15 16 -1" });

//   // OP_RETURN with data
//   cases.push({ name: "OP_RETURN", asm: `OP_RETURN <${bytesToHex(new Uint8Array([1,2,3,4]))}>` });

//   const results = [];

//   for (const c of cases) {
//     try {
//       const hex = c.hex ?? asmToHex(c.asm);
//       const asm = c.asm ?? hexToAsm(c.hex);
//       const rAsm = hexToAsm(hex);
//       const rHex = asmToHex(asm);
//       const pass = normalizeAsm(asm) === normalizeAsm(rAsm) && cleanHex(hex) === cleanHex(rHex);
//       results.push({ name: c.name, pass, asm, hex, rAsm, rHex, err: null });
//     } catch (e) {
//       results.push({ name: c.name, pass: false, asm: c.asm, hex: c.hex, rAsm: null, rHex: null, err: e.message || String(e) });
//     }
//   }

//   return results;
// }

function loadURLParams(){
  const params = new URLSearchParams(window.location.search);
  let result = {}
  if( params.has("hex") ) { result.hex = params.get("hex"); } else { result.hex = ""; }
  try {
    result.hex = cleanHex(result.hex.trim());
    result.asm = hexToAsm(result.hex);
    result.python = asmToPy(result.asm);
    result.cpp = hexToCpp(result.hex);
    result.info = result.hex ? `${(cleanHex(result.hex).length / 2).toString()} bytes` : "";
  } catch (e) {
    result.info = "";
    result.error = e.message || String(e);
  }
  return result;
}

export default function App() {
  let params = loadURLParams();

  const [activeTab, setActiveTab] = useState("ASM"); // "ASM" | "HEX" | "PYTHON" | "CPP" | "DEBUG"
  const [asm, setAsm] = useState(params.asm? params.asm : "");
  const [hex, setHex] = useState(params.hex? params.hex : "");
  const [python, setPython] = useState(params.python? params.python : "");
  const [cpp, setCpp] = useState(params.cpp? params.cpp : "");
  const [error, setError] = useState(params.error? params.error : "");
  const [info, setInfo] = useState(params.info? params.info : "");
  // const [tests, setTests] = useState([]);
  const [stackData, setStackData] = useState("");
  const [altStackData, setAltStackData] = useState("");
  const [searchParams, setSearchParams] = useSearchParams(); // Now useLocation can be used here
  const [debugWord, setDebugWord] = useState();
  const [breakpoints, setBreakpoints] = useState([]);
  const [trace, setTrace] = useState(false);
  const [previousTerms, setPreviousTerms] = useState([]);
  const [status, setStatus] = useState(false);
  const [currentStepStatus, setCurrentStepStatus] = useState(""); // "success" | "error" | ""
  const [executionError, setExecutionError] = useState("");
  const [pcWordMap, setPcWordMap] = useState({});
  const [pc, setPc] = useState(0);
  const [currentDebugStep, setCurrentDebugStep] = useState(0);

  const debAsm = useDebounced(asm);
  const debHex = useDebounced(hex);

  const monaco = useMonaco();

  useEffect(()=>{}, [breakpoints]);

  useEffect(() => {
    if (!monaco) return;

    // Register new language
    monaco.languages.register({ id: "bitcoin-script" });

    // Define highlighting rules
    monaco.languages.setMonarchTokensProvider("bitcoin-script", {
      tokenizer: {
        root: [
          [/\bOP_[A-Z0-9_]+\b/, "keyword"], // opcodes
          [/<[a-zA-Z0-9]+>/, "string"], // push data like <pubKeyHash>
          [/[0-9]+/, "number"],          // numbers
        ],
      },
    });

    // Optional: language configuration (comments, brackets)
    monaco.languages.setLanguageConfiguration("bitcoin-script", {
      comments: {
        lineComment: "//",
      },
    });
  }, [monaco]);

  const computeLineArray = () => {
    if( error ) return;
    let lines = asm.trim().split("\n");
    let cur = 0;
    let lineArray = []
    for(let i=0; i<lines.length; i++) {
      let terms = lines[i].split(/\s+/g);
      lineArray.push(cur);
      for(let j=0; j<terms.length; j++){
        let term = terms[j].trim();
        if( term == "" ) continue;
        if( term.startsWith("<") && term.endsWith(">") )  {
          let l = (term.length - 2) / 2;
          if( l < 76 )
            cur += l;
          else if( 75 < l && l < 256 )
            cur += 1 + l;
          else if( 255 < l && l < 521 )
            cur += 2 + l;
          else
            cur += 4 + l;
        }
        cur++;
      }
    }
    return lineArray;
  };

  const computeBreakpointBytePositions = (lineArray) => {
    const bytePositions = [];
    for( let bp of breakpoints ) {
      bytePositions.push(lineArray[bp - 1]);
    }
    return bytePositions;
  }

  const computePcWordMap = () => {
    let terms = asm.trim().split(/\s+/g);
    let wordMap = {};
    let cur = 0;
    for (let i = 0; i < terms.length; i++) {
      wordMap[cur] = i;
      if( terms[i].startsWith("<") && terms[i].endsWith(">") )  {
        let l = (terms[i].length - 2) / 2;
        if( l < 76 )
          cur += l;
        else if( 75 < l && l < 256 )
          cur += 1 + l;
        else if( 255 < l && l < 521 )
          cur += 2 + l;
        else
          cur += 4 + l;
      }
      cur++;
    }
    wordMap[cur] = terms.length - 1;
    console.log(JSON.stringify(wordMap));
    return wordMap;
  }

  async function handleServerRequest(is_last) {
    normalizeData();
    if(error) return;
    setPreviousTerms(debAsm.trim().split(/\s+/));
    // Handle the server request here

    const response = await fetch("http://localhost:3000/run-job", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: hex })
    }).catch((error) => {
      // Your error is here!
      setInfo("⚠️ Server connection error: " + error);
    });

    if( !response || !response.ok ) return;

    const data = await response.json();
    setTrace(data.trace);
    setStatus(data.status);
    setExecutionError(data.status == "error" ? data.error : "");
    let wordMap = computePcWordMap();
    setPcWordMap(wordMap);
    if( is_last && data.trace && data.trace.length > 0 ) {
      console.log("Set debug step to last ", data.trace.length);
      updateDebugStep(data.trace.length, wordMap, data.trace, data.status);
    } else {
      updateDebugStep(1, wordMap, data.trace, data.status);
    }
    if( data.status == "success" ) setInfo( "✅ Success!" );
    else if( data.status == "error") setInfo("⚠️ " + data.error);
    else setInfo("");
  }

  // Run tests once at load
  // useEffect(() => {
  //   setTests(runSelfTests());
  // }, []);

  useEffect(()=>{
    if((!searchParams.has("hex") && hex != "") || searchParams.get("hex") != hex ){
      try {
        const newHex = searchParams.has("hex") ? searchParams.get("hex") : "";
        const newAsm = newHex ? hexToAsm(newHex) : "";
        setHex(newHex);
        setAsm(newAsm);
        setError("");
        setInfo(newHex ? `${(cleanHex(newHex).length / 2).toString()} bytes` : "");
      } catch (e){
        setInfo("");
        setError(e.message || String(e));
      }
    }
  }, [searchParams])

  const normalizeData = () => {
    if (activeTab === "ASM") { // only compile from active editor
      try {
        const newHex = debAsm.trim() ? asmToHex(debAsm) : "";
        setHex(newHex);
        setPython(asmToPy(debAsm));
        setCpp(hexToCpp(newHex));
        setError("");
        setInfo(newHex ? `${(newHex.length / 2).toString()} bytes` : "");
        if( searchParams.get("hex") != newHex)
          setSearchParams(new URLSearchParams(newHex == "" ? {} : { hex: newHex }));
      } catch (e) {
        setInfo("");
        setError(e.message || String(e));
      }
    } else {
      try {
        const newHex = debHex ? cleanHex(debHex) : "";
        let newAsm = asm;
        if( asmToHex(asm) != newHex )
          newAsm = newHex ? hexToAsm(newHex) : "";
        setHex(newHex);
        setAsm(newAsm);
        setError("");
        setInfo(newHex ? `${(cleanHex(newHex).length / 2).toString()} bytes` : "");
      } catch (e) {
        setInfo("");
        setError(e.message || String(e));
      }
    }
  }


  // Sync HEX when ASM changes
  useEffect(() => {
    normalizeData();
    if( previousTerms.join(" ") !== debAsm.trim().split(/\s+/).join(" ") ){
      setDebugWord(0);
      setTrace(false);
      setStackData("");
      setAltStackData("");
      setPreviousTerms(debAsm.trim().split(/\s+/));
      setPcWordMap({});
      setPc(0);
    }
  }, [activeTab, debAsm, debHex]);

  const onPaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (activeTab === "ASM") setAsm(text);
      else setHex(text);
    } catch {
      setError("Clipboard paste failed");
    }
  };

  const onClear = () => {
    if (activeTab === "ASM") setAsm("");
    else setHex("");
    setError("");
    setInfo("");
  };

  const loadSample = (key) => {
    const s = SAMPLES[key];
    if (!s) return;
    setActiveTab("ASM");
    setAsm(s.asm);
  };

  // Default 0
  const updateDebugStep = (newDebugStep, pcWordMap, trace, status) => {
    normalizeData(debHex);
    if( error ) return;
    setActiveTab("ASM");
    setCurrentDebugStep(newDebugStep);
    if( newDebugStep == 0){
      setPc(0);
      setDebugWord(0);
      setStackData("");
      setAltStackData("");
      setCurrentStepStatus("");
      return;
    }
    let newPc = newDebugStep > trace.length ? trace[trace.length - 1].pc : trace[newDebugStep-1].pc;
    let newDebugWord = pcWordMap[newPc.toString()];
    if( newDebugStep >= trace.length) {
      setCurrentStepStatus(status);
      console.log("Set to final status ", status, " newDebugStep = ", newDebugStep, " trace.length = ", trace.length);
      if( status === "success" )
        setInfo( "✅ Success!" );
      else
        setInfo("⚠️ " + executionError);
      setDebugWord(newDebugWord);
      setPc(newPc);
      setStackData(trace[trace.length - 1].stack.join('\n'));
      setAltStackData(trace[trace.length - 1].altstack.join('\n'));
    } else {
      setCurrentStepStatus("");
      setDebugWord(newDebugWord + 1);
      setPc(newPc);
      setStackData(trace[newDebugStep - 1].stack.join('\n'));
      setAltStackData(trace[newDebugStep - 1].altstack.join('\n'));
    }
  }

  const debugForward = () => {
    if( !trace || trace.length == 0 ) {
      handleServerRequest();
    } else {
      let newDebugStep = currentDebugStep >= trace.length ? trace.length : currentDebugStep + 1;
      updateDebugStep(newDebugStep, pcWordMap, trace, status);
    }
  }

  const debugBackward = () => {
    if( !trace || trace.length == 0 ) {
      handleServerRequest();
    } else {
      updateDebugStep( currentDebugStep > 1 ? currentDebugStep - 1 : 1, pcWordMap, trace, status );
    }
  }

  return (
    <div className="min-h-screen w-full bg-gray-50 text-gray-900 antialiased p-4">
      <div className="max-w-3xl mx-auto">
        <Header />

        <div style={{ width: "100%" }}>
          <Card className="tabs-frame">
            <div className="p-3 flex items-center gap-2 float-left">
              <TabButton id="tab-ASM" active={activeTab === "ASM"} onClick={() => {
                if( !error ) {
                  setActiveTab("ASM");
                }
              }}>
                ASM
              </TabButton>
              <TabButton id="tab-HEX" active={activeTab === "HEX"} onClick={() => {
                if( !error ) {
                  setActiveTab("HEX");
                }
              }}>
                HEX
              </TabButton>
              <TabButton id="tab-PYTHON" active={activeTab === "PYTHON"} onClick={() => {
                if( !error ) {
                  setActiveTab("PYTHON");
                }
              }}>
                PYTHON
              </TabButton>
              <TabButton id="tab-CPP" active={activeTab === "CPP"} onClick={() => {
                if( !error ) {
                  setActiveTab("CPP");
                }
              }}>
                CPP
              </TabButton>
            </div>
            <div className="float-right" style={{ marginRight: "16px" }}>
              <button className="debug-button" title="Start again" onClick={()=>{debugBackward();}}>&larr;</button>
              <button className="debug-button" title="Execute one step" onClick={()=>{debugForward();}}>&rarr;</button>
              <button className="debug-button" title="Execute until breakpoint" onClick={()=>{console.log(computeBreakpointBytePositions(computeLineArray()));}}>&darr;</button>
              <button className="debug-button" title="Execute until the end of execution">&darr;&darr;</button>
            </div>

            <AnimatePresence mode="wait">
              {activeTab === "ASM" ? (
                <motion.div
                  key="asm"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.0 }}
                >
                  <SimpleEditor
                    id="editor-ASM"
                    language={"bitcoin-script"}
                    value={asm}
                    onChange={(e) => {setAsm(e)}}
                    isDebuggable={true}
                    highlightWord={debugWord}
                    breakpoints={breakpoints}
                    onBreakpointsChange={setBreakpoints}
                    status={currentStepStatus}
                  />
                </motion.div>
              ) : activeTab === "HEX" ? (
                <motion.div
                  key="hex"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.0 }}
                >
                  <SimpleEditor
                    id="editor-HEX"
                    value={hex}
                    onChange={(e) => {setHex(e)}}
                    language={"bitcoin-hex"}
                    // onInput={(e) => {
                    //   const regex = /[^0-9a-fA-F]/g;
                    //   if (regex.test(e.target.value)) {
                    //     e.target.value = e.target.value.replace(regex, '');
                    //   }
                    // }}
                    placeholder="e.g. 76a91400112233445566778899aabbccddeeff0011223388ac"
                  />
                </motion.div>
              ) : activeTab === "PYTHON" ? (
                <motion.div
                  key="python"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.0 }}
                >
                  <SimpleEditor
                    id="editor-PYTHON"
                    language={"python"}
                    value={python}
                    onChange={(e) => {setPython(e.target.value)}}
                    placeholder="e.g. python <code>"
                    is_readonly={true}
                  />
                </motion.div>
              ) : (
                <motion.div
                  key="cpp"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.0 }}
                >
                  <SimpleEditor
                    id="editor-CPP"
                    language={"cpp"}
                    value={cpp}
                    onChange={(e) => {setCpp(e.target.value)}}
                    placeholder="e.g. C++ <code>"
                    is_readonly={true}
                  />
                </motion.div>
              )
            }
            </AnimatePresence>
          </Card>
          <Card className="stack-frame">
            <div className="p-3 flex items-center gap-2">
              <TabButton>Stack</TabButton>
              <SimpleEditor
                placeholder="Stack"
                value={stackData}
                is_readonly={true}
              />
            </div>
          </Card>
          <Card className="stack-frame">
            <div className="p-3 flex items-center gap-2">
              <TabButton>AltStack</TabButton>
              <SimpleEditor
                placeholder="AltStack"
                value={altStackData}
                is_readonly={true}
              />
            </div>
          </Card>
            <div className="buttons-container">
            <div className="float-left" width="50%">
              {error && (
                <div className="px-4 pb-4 text-sm text-red-600">
                  ⚠️ {error}
                </div>
              )}
              <div className="ml-auto text-xs text-gray-500">{info}</div>
            </div>
            <div className="float-right">
              <ServerRequestButton caption="Run script on server" handleClick={() => {handleServerRequest(true)}}/>
            </div>
            </div>
        </div>

        <div>PC={pc}</div>
        <div>WORD_MAP={JSON.stringify(pcWordMap)}</div>
        <div width="100%"><pre>{JSON.stringify(trace, null, 2)}</pre></div>

        <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card className="p-4">
            <h3 className="font-medium mb-2">Tips</h3>
            <ul className="list-disc pl-5 text-sm text-gray-700 space-y-1">
              <li>Use <code className="px-1 rounded bg-gray-100">OP_…</code> names for opcodes.</li>
              <li>Wrap data pushes in angle brackets: <code className="px-1 rounded bg-gray-100">&lt;hex&gt;</code>.</li>
              <li>Small integers (−1, 0–16) are accepted as numeric tokens.</li>
              <li>HEX must be even-length and valid hex characters.</li>
            </ul>
          </Card>

          <Card className="p-4">
            <h3 className="font-medium mb-2">Round-trip Notes</h3>
            <p className="text-sm text-gray-700">
              This editor handles all push opcodes (1–75, PUSHDATA1/2/4) and a broad set of standard opcodes.
              Unknown opcodes are shown as <code className="px-1 rounded bg-gray-100">0xNN</code> during HEX → ASM.
              Formatting is stable so that <em>ASM → HEX → ASM</em> and <em>HEX → ASM → HEX</em> round-trip.
            </p>
          </Card>
        </div>

        {/* <Card className="p-4 mt-6">
          <h3 className="font-medium mb-2">Self‑tests</h3>
          <div className="text-sm text-gray-700">
            <p className="mb-2">Quick checks to ensure conversions work as expected.</p>
            <div className="space-y-2">
              {tests.map((t, idx) => (
                <div key={idx} className={`p-2 rounded border ${t.pass ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs px-2 py-0.5 rounded ${t.pass ? 'bg-green-600 text-white' : 'bg-red-600 text-white'}`}>{t.pass ? 'PASS' : 'FAIL'}</span>
                    <span className="font-medium">{t.name}</span>
                  </div>
                  {!t.pass && (
                    <div className="mt-1 text-xs text-gray-800">
                      {t.err ? (
                        <div>Error: {t.err}</div>
                      ) : (
                        <div>
                          <div><strong>asm</strong>: {t.asm}</div>
                          <div><strong>hex</strong>: {t.hex}</div>
                          <div><strong>rAsm</strong>: {t.rAsm}</div>
                          <div><strong>rHex</strong>: {t.rHex}</div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </Card> */}
      </div>
    </div>
  );
}
