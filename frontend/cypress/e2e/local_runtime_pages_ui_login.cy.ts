/// <reference types="cypress" />

const requiredEnv = (name: string) => {
  const value = Cypress.env(name);
  if (typeof value !== "string" || !value) {
    throw new Error(`${name} must be provided`);
  }
  return String(value);
};

describe("Local runtime pages via UI login", () => {
  it("logs in through local auth and loads the main Mission Control routes", () => {
    const token = requiredEnv("LOCAL_AUTH_TOKEN");

    cy.visit("/sign-in");
    cy.get("#local-auth-token").type(token, { log: false });
    cy.contains("button", /^Continue$/i).click();

    cy.visit("/dashboard");
    cy.waitForAppLoaded();
    cy.contains(/Mission hub/i).should("be.visible");
    cy.contains(/Insight window/i).should("be.visible");

    cy.visit("/products");
    cy.waitForAppLoaded();
    cy.contains(/^Products$/i).should("be.visible");

    cy.visit("/docs");
    cy.waitForAppLoaded();
    cy.contains(/^Docs$/i).should("be.visible");

    cy.visit("/team");
    cy.waitForAppLoaded();
    cy.contains(/^Team$/i).should("be.visible");

    cy.visit("/boards");
    cy.waitForAppLoaded();
    cy.contains(/Boards/i).should("be.visible");

    cy.visit("/agents");
    cy.waitForAppLoaded();
    cy.contains(/^Agents$/i).should("be.visible");

    cy.visit("/gateways");
    cy.waitForAppLoaded();
    cy.contains(/^Gateways$/i).should("be.visible");
  });
});

export {};
