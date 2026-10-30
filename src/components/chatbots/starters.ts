import { autoLayout } from "./layout";
import type { Doc } from "./editor";
import type { FlowDefinition, FlowEdge, FlowNode, TriggerType } from "./types";

export type Starter = {
  id: string;
  name: string;
  /** One line shown on the card. */
  summary: string;
  /** What the bot does, in plain words. */
  steps: string[];
  triggerType: TriggerType;
  triggerKeywords: string[];
  build: () => FlowDefinition;
};

const at = { x: 0, y: 0 };

function node<T extends FlowNode["type"]>(id: string, type: T, data: Extract<FlowNode, { type: T }>["data"]): FlowNode {
  return { id, type, position: at, data } as FlowNode;
}

function edge(id: string, from: string, to: string, label?: string): FlowEdge {
  return { id, from, to, ...(label === undefined ? {} : { label }) };
}

function finish(start: string, nodes: FlowNode[], edges: FlowEdge[]): FlowDefinition {
  return autoLayout({ version: 1, start, nodes, edges });
}

function welcomeAndMenu(): FlowDefinition {
  return finish(
    "n1",
    [
      node("n1", "send_buttons", {
        text: "Hi, thanks for messaging us. What can we help you with?",
        buttons: [
          { id: "b1", title: "Our services" },
          { id: "b2", title: "Opening hours" },
          { id: "b3", title: "Talk to a person" },
        ],
      }),
      node("n2", "send_text", { text: "Here is what we offer. Replace this text with a short list of your products or services." }),
      node("n3", "send_text", { text: "We are open Monday to Saturday, 9 am to 6 pm. Replace this with your own hours." }),
      node("n4", "handoff", { message: "Thanks. A member of our team will reply here shortly." }),
      node("n5", "end", {}),
    ],
    [edge("e1", "n1", "n2", "b1"), edge("e2", "n1", "n3", "b2"), edge("e3", "n1", "n4", "b3"), edge("e4", "n2", "n5"), edge("e5", "n3", "n5")],
  );
}

function collectLead(): FlowDefinition {
  return finish(
    "n1",
    [
      node("n1", "send_text", { text: "Thanks for getting in touch. We just need a few details so we can help you properly." }),
      node("n2", "ask", { text: "What is your name?", variable: "name", validate: "text", retryText: "", maxRetries: 2 }),
      node("n3", "ask", {
        text: "Thanks {{name}}. What is your email address?",
        variable: "email",
        validate: "email",
        retryText: "That does not look like an email address. Please check it and send it again.",
        maxRetries: 2,
      }),
      node("n4", "ask", { text: "And what do you need help with?", variable: "need", validate: "text", retryText: "", maxRetries: 2 }),
      node("n5", "add_tag", { tag: "New lead" }),
      node("n6", "send_text", { text: "Thank you, {{name}}. We have your details and will get back to you soon." }),
      node("n7", "handoff", {}),
    ],
    [edge("e1", "n1", "n2"), edge("e2", "n2", "n3"), edge("e3", "n3", "n4"), edge("e4", "n4", "n5"), edge("e5", "n5", "n6"), edge("e6", "n6", "n7")],
  );
}

function businessHours(): FlowDefinition {
  return finish(
    "n1",
    [
      node("n1", "send_text", {
        text: "Our hours are Monday to Saturday, 9 am to 6 pm. If you message us outside these hours, we will reply when we open.",
      }),
      node("n2", "send_buttons", {
        text: "Is there anything else we can help with?",
        buttons: [
          { id: "b1", title: "Talk to the team" },
          { id: "b2", title: "No, thanks" },
        ],
      }),
      node("n3", "handoff", { message: "Thanks. We have passed your message to the team and will reply as soon as we can." }),
      node("n4", "send_text", { text: "Thanks for getting in touch. Have a lovely day." }),
      node("n5", "end", {}),
    ],
    [edge("e1", "n1", "n2"), edge("e2", "n2", "n3", "b1"), edge("e3", "n2", "n4", "b2"), edge("e4", "n4", "n5")],
  );
}

export const STARTERS: readonly Starter[] = [
  {
    id: "welcome-menu",
    name: "Welcome and menu",
    summary: "Greet new customers and let them pick what they need.",
    steps: ["Greets the customer with three buttons", "Answers with your services or opening hours", "Passes the chat to your team on request"],
    triggerType: "first_message",
    triggerKeywords: [],
    build: welcomeAndMenu,
  },
  {
    id: "collect-lead",
    name: "Collect lead details",
    summary: "Ask for a name, email and need, then tag the contact as a new lead.",
    steps: ["Asks for name, email and what they need", "Checks that the email looks right", "Tags the contact and hands over to your team"],
    triggerType: "keyword",
    triggerKeywords: ["quote", "enquiry", "interested"],
    build: collectLead,
  },
  {
    id: "business-hours",
    name: "Business hours reply",
    summary: "Answer when people ask if you are open.",
    steps: ["Replies with your opening hours", "Offers to pass the chat to your team", "Says goodbye if nothing else is needed"],
    triggerType: "keyword",
    triggerKeywords: ["hours", "open", "timing"],
    build: businessHours,
  },
];

export const getStarter = (id: string | null | undefined): Starter | undefined => STARTERS.find((s) => s.id === id);

/** A fresh, independent copy of the starter as an editable document. Calling it twice never shares objects. */
export function starterDoc(starter: Starter): Doc {
  return { name: starter.name, triggerType: starter.triggerType, triggerKeywords: [...starter.triggerKeywords], phoneNumberId: null, flow: starter.build() };
}
