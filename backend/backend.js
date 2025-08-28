import express from "express";
import { exec } from "child_process";
import { stderr } from "process";
import cors from "cors";
import process from "process";


const app = express();
app.use(express.json());
app.use(cors({ origin: "http://localhost:5173" }));

function run_debugger(input){

}

app.get("/run-job", (req, res) => {
  const input = req.body.input;

  // Run C++ program
//   exec(`./myprog ${input}`, (error, stdout, stderr) => {
  exec(process.cwd() + `/indexer/build/bin/bitcoin-debugger --code=${input}`, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error: ${error.message}`);
      res.status(500).json({ error: error.message, status:"error" });
    }
    if (stderr) {
      console.error(`Stderr: ${stderr}`);
    }
    res.json({ output: stdout.trim(), status: "success" });
  });
});

app.post("/run-job", (req, res) => {
  const input = req.body.input;

  // Run C++ program
  exec(process.cwd() + `/../indexer/build/bin/bitcoin-debugger --code=${input}`, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error: ${error.message}`);
      return res.status(500).json({ error: error.message, status: "error", output: stdout.trim() });
    }
    if (stderr) {
      console.error(`Stderr: ${stderr}`);
    }
    res.json({ output: stdout.trim(), status: "success" });
  });
});

app.listen(3000, () => console.log("Server running on port 3000"));
