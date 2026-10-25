import type { Quest } from "../shared/types.ts";

type Preset = Omit<Quest, "id">;

/** Scripted quests for the stage demo. Stage the room with exactly these objects. */
export const PRESETS: Record<string, Preset> = {
  desk: {
    title: "The Cluttered Desk of Doom",
    type: "boss",
    intro: "Brave one, chaos has claimed your desk. Three relics are out of place. Let us restore order.",
    goalCheck: "Is the desk clear, with no water bottle or book left on it?",
    steps: [
      {
        id: "s1",
        action: "grab",
        target: "water bottle",
        destination: "",
        instruction: "First, an empty bottle lurks on the desk. Find it and pick it up.",
        success: "A hand is holding the water bottle.",
        check: "Is a hand holding the water bottle?",
      },
      {
        id: "s2",
        action: "drop",
        target: "water bottle",
        destination: "trash can",
        instruction: "Now carry it to the trash can and drop it in.",
        success: "The water bottle is inside the trash can.",
        check: "Is the water bottle inside the trash can?",
      },
      {
        id: "s3",
        action: "grab",
        target: "book",
        destination: "",
        instruction: "A tome of knowledge rests on the desk. Take it.",
        success: "A hand is holding the book.",
        check: "Is a hand holding the book?",
      },
      {
        id: "s4",
        action: "place",
        target: "book",
        destination: "backpack",
        instruction: "Stow the book safely in your backpack.",
        success: "The book is inside the backpack.",
        check: "Is the book inside the backpack?",
      },
    ],
  },
  trash: {
    title: "Banish the Bottle",
    type: "side",
    intro: "A lone bottle mocks you from the desk. Send it where it belongs.",
    goalCheck: "Is the water bottle in the trash can and off the desk?",
    steps: [
      {
        id: "s1",
        action: "grab",
        target: "water bottle",
        destination: "",
        instruction: "Find the bottle on the desk and pick it up.",
        success: "A hand is holding the water bottle.",
        check: "Is a hand holding the water bottle?",
      },
      {
        id: "s2",
        action: "drop",
        target: "water bottle",
        destination: "trash can",
        instruction: "Carry it to the trash can and drop it in.",
        success: "The water bottle is inside the trash can.",
        check: "Is the water bottle inside the trash can?",
      },
    ],
  },
  seat: {
    title: "The Throne Awaits",
    type: "side",
    intro: "Your weary legs deserve a throne. Let us find you a chair.",
    goalCheck: "Is the player seated on the chair?",
    steps: [
      {
        id: "s1",
        action: "find",
        target: "chair",
        destination: "",
        instruction: "Somewhere nearby stands a chair. Sweep slowly to find it.",
        success: "The chair is clearly visible and centered.",
        check: "Is a chair clearly visible straight ahead?",
      },
      {
        id: "s2",
        action: "sit",
        target: "chair",
        destination: "",
        instruction: "Walk to the chair, find the seat with your hand, and sit down.",
        success: "The view is at seated height on the chair.",
        check: "Is the view at seated height, on or directly in front of the chair?",
      },
    ],
  },
};
