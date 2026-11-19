// Wrapping the whole extension in a JS function and calling it immediately 
// (ensures all global variables set in this extension cannot be referenced outside its scope)
(async function(codioIDE, window) {

  // Refer to Anthropic's guide on system prompts: https://docs.anthropic.com/claude/docs/system-prompts
  const systemPrompt = "{% prompt 'POP_PROJECT_2_SYSTEM' %}"

  // register(id: unique button id, name: name of button visible in Coach, function: function to call when button is clicked) 
  // Update the "iNeedHelpButton" button id string with a unique name for each assistant you create
  // Update the "I have a question" string to change the button name visible in Coach
  codioIDE.coachBot.register("iNeedHelpButton", "I have a question", onButtonPress)
  
  // function called when I have a question button is pressed
  async function onButtonPress() {
    codioIDE.coachBot.write("Please type or paste any questions you have about this assessment. If you want me to look into your files, have them open in your tabs.")

    // the messages object that will persist conversation history
    let messages = []
    
    // Function that automatically collects all available context 
    // returns the following object: {guidesPage, assignmentData, files, error}
    // guidesPage object contains information on current open guidesPage only
    // assignmentData object has student and assignment information
    // files object has information for all open files
    // error object has information on student code execution result and errorState information
    const context = await codioIDE.coachBot.getContext()
    codioIDE.coachBot.write(JSON.stringify(context))

    while (true) {
      
      let input

      try {
        input = await codioIDE.coachBot.input()
      } catch (e) {
          if (e.message == "Cancelled") {
            break
          }
      }

      
      // Specify condition here to exit loop gracefully
//      if (input == "Thanks") {
//        break
//      }
      
      //Define your assistant's userPrompt - this is where you will provide all the context you collected along with the task you want the LLM to generate text for.
      const userPrompt = `Here is the question the student has asked:
        <student_question>
        ${input}
        </student_question>

       Here is the description of the programming assignment the student is working on:

      <assignment>
      ${context.guidesPage.content}
      </assignment>
      
      Here is the student's current code:
      
      <current_code>
      ${context.files[0]}
      </current_code> 
      `

      messages.push({
        "role": "user", 
        "content": userPrompt
      })

      const result = await codioIDE.coachBot.ask({
        systemPrompt: systemPrompt,
        messages: messages
      }, {preventMenu: true})
      
      messages.push({"role": "assistant", "content": result.result})

 
    }
   }
})(window.codioIDE, window)